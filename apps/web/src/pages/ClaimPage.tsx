import {
	anchorAmountProblemCopy,
	anchorCashOutSupport,
} from "@flexipay/web-lib/anchor-amount"
import { type ClaimView } from "@flexipay/web-lib/claim-contract"
import { buildClaimEndpoint } from "@flexipay/web-lib/claim-endpoint"
import { isPasskeyWalletConfigured } from "@flexipay/web-lib/passkey-config"
import { useEffect, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import {
	ClaimApiError,
	acceptClaim,
	describeClaimError,
	getClaim,
} from "../api/claimClient"
import { AnchorClaimSection } from "../components/claim/AnchorClaimSection"
import { PasskeyClaimSection } from "../components/claim/PasskeyClaimSection"
import {
	Button,
	InfoPopover,
	Notice,
	SimulatedLabel,
	TextField,
} from "../components/ui"

type DestinationType = ClaimView["allowedDestinationTypes"][number]

const CURRENCY_DECIMALS: Readonly<Record<string, number>> = {
	USD: 2,
	PHP: 2,
	BRL: 2,
	ZAR: 2,
	USDC: 7,
}

const PAYMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
	quoted: "Quoted",
	awaiting_funding: "Awaiting funding",
	funded: "Funded",
	processing: "Processing",
	paid: "Paid",
	cancelled: "Cancelled",
	failed: "Failed",
	refunding: "Refunding",
	refunded: "Refunded",
	expired: "Expired",
}

/** Accept CTA only when settle is waiting (typically after fund → processing). `funded` alone yields API 409. */
const PAYMENT_ACCEPTABLE_STATUSES = new Set(["processing"])

const TERMINAL_PAYMENT_STATUSES = new Set([
	"paid",
	"cancelled",
	"failed",
	"refunded",
	"expired",
])

const CLOSED_PAYMENT_STATUSES = new Set([
	"cancelled",
	"failed",
	"refunded",
	"expired",
])

const isCrypto = (type: DestinationType): boolean =>
	type === "crypto_wallet" || type === "crypto_custodial"

// CCR-17: crypto (address) and fiat (accountNumber / phoneNumber) accept paths are mounted.
const supportsClaimAccept = (
	type: DestinationType | "",
): type is DestinationType =>
	type === "crypto_wallet" ||
	type === "crypto_custodial" ||
	type === "bank_account" ||
	type === "ewallet"

const optionCopy = (
	type: DestinationType,
): { title: string; detail: string } => {
	switch (type) {
		case "bank_account":
			return { title: "Bank account", detail: "Local bank payout" }
		case "ewallet":
			return { title: "E-wallet", detail: "Mobile wallet payout" }
		case "crypto_wallet":
			return { title: "Crypto wallet", detail: "Stellar testnet address" }
		case "crypto_custodial":
			return {
				title: "Custodial wallet",
				detail: "Backend-held testnet wallet",
			}
	}
}

const detailLabel = (type: DestinationType): string => {
	if (isCrypto(type)) return "Stellar testnet wallet address"
	if (type === "ewallet") return "E-wallet number"
	return "Bank account number"
}

const detailPlaceholder = (type: DestinationType): string =>
	isCrypto(type) ? "G…" : "Account details"

const formatAmount = (
	amount: string,
	currency: string,
): { value: string; currency: string } => {
	const decimals = CURRENCY_DECIMALS[currency] ?? 0
	const padded = amount.padStart(decimals + 1, "0")
	const whole = decimals === 0 ? padded : padded.slice(0, -decimals)
	const fraction =
		decimals === 0
			? ""
			: padded.slice(-decimals).replace(/0+$/, "").padEnd(2, "0")
	const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
	return {
		value: fraction ? `${grouped}.${fraction}` : grouped,
		currency,
	}
}

const formatTimestamp = (iso: string): string =>
	new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(iso))

const claimStatusTone = (status: ClaimView["status"]): string => {
	if (status === "accepted") return "success"
	if (status === "expired") return "danger"
	return "warning"
}

const paymentStatusTone = (status: string): string => {
	if (status === "paid") return "success"
	if (status === "failed" || status === "expired") return "danger"
	if (status === "cancelled" || status === "refunded") return "muted"
	if (status === "processing" || status === "funded") return "warning"
	return "neutral"
}

const claimStatusLabel = (status: ClaimView["status"]): string => {
	if (status === "accepted") return "Accepted"
	if (status === "expired") return "Expired"
	return "Open"
}

const paymentStatusLabel = (status: string): string =>
	PAYMENT_STATUS_LABELS[status] ?? status

const closedClaimMessage = (claim: ClaimView): string => {
	if (claim.status === "expired") {
		return "This claim link has expired. No release was made by this page."
	}
	if (claim.paymentStatus === "paid") {
		return "Paid: confirmed by the claim API after the release."
	}
	if (CLOSED_PAYMENT_STATUSES.has(claim.paymentStatus)) {
		return `The claim API reports ${paymentStatusLabel(claim.paymentStatus)}. This page does not treat that as paid.`
	}
	return "Accepted. The payment is moving through the API; this page polls until it reaches a final state."
}

const notReadyMessage = (claim: ClaimView): string => {
	if (
		claim.paymentStatus === "quoted" ||
		claim.paymentStatus === "awaiting_funding"
	) {
		return "This claim is open, but the payment is not funded yet. Ask the sender to fund it before accepting."
	}
	if (claim.paymentStatus === "funded") {
		return "This claim is open, but the payment is not ready to accept yet. Wait until the API reports processing (settle waiting), then accept."
	}
	return `This claim cannot be accepted while the payment is ${paymentStatusLabel(claim.paymentStatus)}.`
}

const closedClaimTone = (claim: ClaimView): "info" | "warning" =>
	claim.status === "expired" || CLOSED_PAYMENT_STATUSES.has(claim.paymentStatus)
		? "warning"
		: "info"

const asClaimError = (cause: unknown): ClaimApiError =>
	cause instanceof ClaimApiError
		? cause
		: new ClaimApiError(0, "unknown_error", "The claim could not be loaded.")

const isAbortError = (cause: unknown): boolean =>
	cause instanceof DOMException && cause.name === "AbortError"

export default function ClaimPage() {
	const { claimToken } = useParams<{ claimToken: string }>()
	const [claim, setClaim] = useState<ClaimView | null>(null)
	const [loading, setLoading] = useState(true)
	const [loadError, setLoadError] = useState<ClaimApiError | null>(null)
	const [pollError, setPollError] = useState<string | null>(null)
	const [reloadKey, setReloadKey] = useState(0)
	const [selectedType, setSelectedType] = useState<DestinationType | "">("")
	const [passkeySelected, setPasskeySelected] = useState(false)
	const [anchorSelected, setAnchorSelected] = useState(false)
	const [detail, setDetail] = useState("")
	const [accepting, setAccepting] = useState(false)
	const [acceptError, setAcceptError] = useState<string | null>(null)
	const [expired, setExpired] = useState(false)
	const acceptLock = useRef(false)
	const acceptAbort = useRef<AbortController | null>(null)
	const idempotencyKey = useRef<string | null>(null)
	const claimStatus = claim?.status
	const paymentStatus = claim?.paymentStatus

	useEffect(() => {
		if (!claimToken) {
			setLoadError(
				new ClaimApiError(
					404,
					"not_found",
					"This claim link is invalid or no longer exists.",
				),
			)
			setLoading(false)
			return
		}

		const controller = new AbortController()
		let active = true
		setLoading(true)
		setLoadError(null)
		setClaim(null)

		getClaim(claimToken, controller.signal)
			.then((next) => {
				if (active) setClaim(next)
			})
			.catch((cause: unknown) => {
				if (!active || isAbortError(cause)) return
				setLoadError(asClaimError(cause))
			})
			.finally(() => {
				if (active) setLoading(false)
			})

		return () => {
			active = false
			controller.abort()
		}
	}, [claimToken, reloadKey])

	useEffect(() => {
		if (
			!claimToken ||
			claimStatus !== "accepted" ||
			TERMINAL_PAYMENT_STATUSES.has(paymentStatus ?? "")
		)
			return

		const controller = new AbortController()
		let active = true
		const timer = window.setInterval(() => {
			void getClaim(claimToken, controller.signal)
				.then((next) => {
					if (!active) return
					setClaim(next)
					setPollError(null)
				})
				.catch((cause: unknown) => {
					if (active && !isAbortError(cause))
						setPollError(asClaimError(cause).message)
				})
		}, 2_000)

		return () => {
			active = false
			window.clearInterval(timer)
			controller.abort()
		}
	}, [claimStatus, paymentStatus, claimToken])

	useEffect(
		() => () => {
			acceptAbort.current?.abort()
		},
		[],
	)

	useEffect(() => {
		if (!claim?.expiresAt || claim.status !== "open") {
			setExpired(false)
			return
		}
		const expiresAt = new Date(claim.expiresAt).getTime()
		const check = () => setExpired(Date.now() >= expiresAt)
		check()
		const timer = window.setInterval(check, 1_000)
		return () => window.clearInterval(timer)
	}, [claim?.expiresAt, claim?.status])

	const updateSelection = (type: DestinationType) => {
		if (!supportsClaimAccept(type)) return
		setPasskeySelected(false)
		setAnchorSelected(false)
		setSelectedType(type)
		setDetail("")
		setAcceptError(null)
		idempotencyKey.current = null
	}

	const selectPasskey = () => {
		if (expired || accepting || !isPasskeyWalletConfigured) return
		setAnchorSelected(false)
		setPasskeySelected(true)
		setSelectedType("")
		setDetail("")
		setAcceptError(null)
		idempotencyKey.current = null
	}

	const selectAnchor = () => {
		if (expired || accepting || !anchorCashOut?.available) return
		setPasskeySelected(false)
		setAnchorSelected(true)
		setSelectedType("")
		setDetail("")
		setAcceptError(null)
		idempotencyKey.current = null
	}

	const useCryptoWallet = () => {
		setPasskeySelected(false)
		setAnchorSelected(false)
		setSelectedType("")
		setDetail("")
		setAcceptError(null)
		idempotencyKey.current = null
	}

	const updateDetail = (value: string) => {
		setDetail(value)
		setAcceptError(null)
		idempotencyKey.current = null
	}

	const paymentAcceptable = claim
		? PAYMENT_ACCEPTABLE_STATUSES.has(claim.paymentStatus)
		: false
	// CCR-22: the withdraw body omits `amount`, so the API uses the claim settle net. The
	// indicative quote is limited to 1–10 USDC of the claim amount and is skipped otherwise;
	// the gross claim amount is never substituted for the net.
	const anchorCashOut = claim
		? anchorCashOutSupport(claim.amount.amount, claim.amount.currency)
		: null
	const hasSupportedType =
		claim?.allowedDestinationTypes.some(supportsClaimAccept) ?? false
	const canAccept =
		Boolean(
			claim &&
			!loading &&
			!expired &&
			claim.status === "open" &&
			supportsClaimAccept(selectedType) &&
			detail.trim(),
		) &&
		paymentAcceptable &&
		!accepting

	const handleAccept = async () => {
		if (
			!claimToken ||
			!claim ||
			loading ||
			expired ||
			accepting ||
			!supportsClaimAccept(selectedType) ||
			!paymentAcceptable ||
			!detail.trim() ||
			acceptLock.current
		)
			return

		const endpoint = buildClaimEndpoint({
			type: selectedType,
			detail: detail.trim(),
			currency: claim.amount.currency,
			country: claim.corridor.to.country,
		})

		acceptLock.current = true
		setAccepting(true)
		setAcceptError(null)
		const controller = new AbortController()
		acceptAbort.current = controller
		const key = idempotencyKey.current ?? `claim-accept-${crypto.randomUUID()}`
		idempotencyKey.current = key

		try {
			const response = await acceptClaim(
				claimToken,
				{ endpoint },
				key,
				controller.signal,
			)
			setClaim(response.claim)
		} catch (cause) {
			if (controller.signal.aborted) return
			setAcceptError(
				cause instanceof ClaimApiError
					? describeClaimError(cause)
					: "The claim could not be accepted. Try again.",
			)
		} finally {
			if (!controller.signal.aborted) {
				setAccepting(false)
				acceptLock.current = false
			}
		}
	}

	const amount = claim
		? formatAmount(claim.amount.amount, claim.amount.currency)
		: null

	return (
		<main className="phone-shell">
			<div className="phone-frame">
				<header className="phone-header">
					<span className="phone-brand">FlexiPay</span>
					<SimulatedLabel />
				</header>

				<div className="stack">
					<div>
						<p className="eyebrow">Payment from Demo Platform</p>
						<h1 className="phone-title">Claim your payment</h1>
						<p className="muted">
							Choose how you want to receive it. This is a testnet build and no
							real money moves.
						</p>
					</div>

					{loading ? (
						<p className="muted" role="status">
							Loading claim…
						</p>
					) : null}

					{loadError && !claim ? (
						<div className="stack">
							<Notice tone="warning">{loadError.message}</Notice>
							<Button
								variant="secondary"
								onClick={() => setReloadKey((value) => value + 1)}
							>
								Try again
							</Button>
						</div>
					) : null}

					{claim && amount ? (
						<>
							<div className="amount-display">
								<div>
									<span className="amount-display__label">Amount</span>
									<span className="amount-display__value">{amount.value}</span>
									<span className="amount-display__currency">
										{amount.currency}
									</span>
								</div>
								<InfoPopover label="Amount and fee">
									The amount is the expected receive side from the payment
									quote. The public claim response does not include a fee or net
									amount, so none is inferred here.
								</InfoPopover>
							</div>
							<p className="form-note">
								Fee and net are not fields of the public claim view; no fee is
								computed in the browser.
							</p>

							<div className="claim-status-row">
								<span
									className={`status-badge status-badge--${claimStatusTone(claim.status)}`}
									data-claim-status={claim.status}
								>
									<span className="status-badge__dot" aria-hidden="true" />
									Claim {claimStatusLabel(claim.status)}
								</span>
								<span
									className={`status-badge status-badge--${paymentStatusTone(claim.paymentStatus)}`}
									data-payment-status={claim.paymentStatus}
								>
									<span className="status-badge__dot" aria-hidden="true" />
									{paymentStatusLabel(claim.paymentStatus)}
								</span>
							</div>

							<div className="claim-meta">
								<p>
									{claim.corridor.from.country} → {claim.corridor.to.country} ·{" "}
									{claim.corridor.to.currency}
								</p>
								<p>
									The claim link is valid until{" "}
									{formatTimestamp(claim.expiresAt)}.
								</p>
							</div>

							{claim.status === "open" ? (
								<>
									<fieldset className="option-list">
										<legend className="field__label">Receive to</legend>
										{claim.allowedDestinationTypes.map((type) => {
											const copy = optionCopy(type)
											const supported = supportsClaimAccept(type)
											return (
												<label className="option-card" key={type}>
													<input
														type="radio"
														name="receive"
														value={type}
														checked={selectedType === type}
														disabled={accepting || expired || !supported}
														onChange={() => updateSelection(type)}
													/>
													<span className="option-card__body">
														<span className="option-card__title">
															{copy.title}
														</span>
														<span className="option-card__detail">
															{supported
																? copy.detail
																: "Not available for this claim."}
														</span>
													</span>
												</label>
											)
										})}{" "}
										{/* CCR-20 deploy is accepted and mounted; prepare/submit are still stubs, so the
										    deployed panel says claim signing is unavailable. The anchor cash-out stays
										    a visibly unavailable reference (M1). The G-address crypto flow is untouched. */}
										<label
											className={`option-card${isPasskeyWalletConfigured ? "" : " option-card--unavailable"}`}
											data-testid="claim-passkey-option"
										>
											<input
												type="radio"
												name="receive"
												value="passkey"
												checked={passkeySelected}
												disabled={
													expired || accepting || !isPasskeyWalletConfigured
												}
												onChange={selectPasskey}
											/>
											<span className="option-card__body">
												<span className="option-card__title">
													Create passkey wallet
												</span>
												<span className="option-card__detail">
													{isPasskeyWalletConfigured
														? "Stellar testnet contract account, unlocked by your fingerprint or face."
														: "Not available in this build: the public testnet RPC URL or network passphrase is not configured."}
												</span>
											</span>
										</label>
										<label
											className={`option-card${anchorCashOut?.available ? "" : " option-card--unavailable"}`}
											data-testid="claim-anchor-option"
										>
											<input
												type="radio"
												name="receive"
												value="anchor"
												checked={anchorSelected}
												disabled={
													expired || accepting || !anchorCashOut?.available
												}
												onChange={selectAnchor}
											/>
											<span className="option-card__body">
												<span className="option-card__title">
													Cash out to bank (reference anchor)
												</span>
												<span className="option-card__detail">
													{anchorCashOut?.available
														? "Reference anchor on testnet, in the anchor's sandbox. Starts after the vault release to a classic G… wallet."
														: anchorCashOut
															? anchorAmountProblemCopy(anchorCashOut.problem)
															: "Not available for this claim."}
												</span>
											</span>
										</label>
									</fieldset>
									<p className="form-note">
										Bank, e-wallet and crypto destinations use the claim accept
										API. The passkey wallet is created on testnet and signs the
										release with your fingerprint or face. The reference anchor
										cash-out is a testnet demo for 1 to 10 USDC, after the vault
										release. Bank and e-wallet payouts remain simulated.
									</p>
									{passkeySelected ? (
										<PasskeyClaimSection
											key={claimToken}
											token={claimToken ?? ""}
											claimExpired={expired}
											claimClosed={CLOSED_PAYMENT_STATUSES.has(
												claim.paymentStatus,
											)}
											onUseCryptoWallet={useCryptoWallet}
										/>
									) : null}{" "}
									{anchorSelected && anchorCashOut?.available ? (
										<AnchorClaimSection
											key={`anchor-${claimToken}`}
											token={claimToken ?? ""}
											quoteAmount={anchorCashOut.quoteAmount}
											claim={claim}
											claimExpired={expired}
											onUseCryptoWallet={useCryptoWallet}
										/>
									) : null}
									{!passkeySelected && !anchorSelected && selectedType ? (
										<div className="claim-detail">
											<TextField
												id="claim-detail"
												label={detailLabel(selectedType)}
												placeholder={detailPlaceholder(selectedType)}
												autoComplete="off"
												value={detail}
												disabled={accepting || expired}
												onChange={(event) => updateDetail(event.target.value)}
												hint={
													isCrypto(selectedType)
														? "Testnet only. Paste a public wallet address; never a secret key."
														: "Only the claimed endpoint type is sent."
												}
											/>
										</div>
									) : null}
									{!passkeySelected && !anchorSelected && expired ? (
										<Notice tone="warning">
											This claim link has expired. No release was made by this
											page.
										</Notice>
									) : null}
									{!passkeySelected && !anchorSelected && !paymentAcceptable ? (
										<Notice tone="warning">{notReadyMessage(claim)}</Notice>
									) : null}
									{!passkeySelected && !anchorSelected && acceptError ? (
										<Notice tone="warning" data-testid="claim-accept-error">
											{acceptError}
										</Notice>
									) : null}
									{passkeySelected ||
									anchorSelected ? null : hasSupportedType ? (
										<>
											<Button
												onClick={() => void handleAccept()}
												disabled={!canAccept}
												data-testid="claim-accept"
											>
												{accepting ? "Accepting…" : "Accept payment"}
											</Button>
											<p className="form-note">
												Accepting sends one idempotent request. The payment is
												marked paid only when the claim API returns that state.
											</p>
										</>
									) : (
										<Notice tone="warning">
											This claim has no endpoint that the current claim API can
											accept.
										</Notice>
									)}
								</>
							) : (
								<>
									<Notice tone={closedClaimTone(claim)}>
										{closedClaimMessage(claim)}
									</Notice>
									{/* M1 anchor cash-out needs the vault release first, so it is reachable only
									    after the claim is accepted to a classic G… account. Same panel, no
									    new screen; the release and anchor statuses stay separate inside. */}
									{claim.status === "accepted" && anchorCashOut?.available ? (
										<div className="stack" data-testid="anchor-accepted-block">
											<p className="option-card__title">
												Cash out to bank (reference anchor)
											</p>
											<AnchorClaimSection
												key={`anchor-accepted-${claimToken}`}
												token={claimToken ?? ""}
												quoteAmount={anchorCashOut.quoteAmount}
												claim={claim}
												claimExpired={expired}
											/>
										</div>
									) : null}{" "}
									{claim.status === "accepted" &&
									anchorCashOut &&
									!anchorCashOut.available ? (
										<Notice
											tone="info"
											data-testid="anchor-accepted-unavailable"
										>
											Reference anchor cash-out unavailable:{" "}
											{anchorAmountProblemCopy(anchorCashOut.problem)}
										</Notice>
									) : null}
								</>
							)}

							{pollError ? <Notice tone="warning">{pollError}</Notice> : null}
						</>
					) : null}
				</div>
			</div>
		</main>
	)
}
