import { type ClaimView } from "@flexipay/web-lib/claim-contract"
import { buildClaimEndpoint } from "@flexipay/web-lib/claim-endpoint"
import { useEffect, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import {
	ClaimApiError,
	acceptClaim,
	describeClaimError,
	getClaim,
} from "../api/claimClient"
import {
	aboutDaysLeft,
	CLAIM_EXPIRED_ASK_SENDER,
	formatClaimValidUntil,
} from "../claim/expiry"
import { NoWalletYetHelp } from "../components/claim/NoWalletYetHelp"
import { CopyableValue } from "../components/CopyableValue"
import { SolanaWalletPanel } from "../components/solana/SolanaWalletPanel"
import { Button, Notice, SimulatedLabel, TextField } from "../components/ui"
import { Icon, type IconName } from "../components/ui/Icon"
import { useLiveMoney } from "../live/LiveMoney"
import { displayMoney, isPoundDisplayCurrency } from "../payments/quoteDisplay"
import { type ConnectedSolanaWallet } from "../solana/walletStandard"
import "../styles/pages/claim.css"

type DestinationType = ClaimView["allowedDestinationTypes"][number]

/** Legacy split for non-pound claim amounts (USD/USDC/fiat). Pounds use displayMoney. */
const CURRENCY_DECIMALS: Readonly<Record<string, number>> = {
	USD: 2,
	PHP: 2,
	BRL: 2,
	ZAR: 2,
	USDC: 7,
}

const PAYMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
	quoted: "Quoted",
	awaiting_funding: "Waiting for payment",
	funded: "Paid in",
	processing: "On its way",
	paid: "Delivered",
	cancelled: "Cancelled",
	failed: "Failed",
	refunding: "Returning money",
	refunded: "Money returned",
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
): { title: string; detail: string; icon: IconName } => {
	switch (type) {
		case "bank_account":
			return {
				title: "Bank account",
				detail: "Straight into your bank",
				icon: "bank",
			}
		case "ewallet":
			return {
				title: "E-wallet",
				detail: "To your mobile money app",
				icon: "phone",
			}
		case "crypto_wallet":
			return {
				title: "Crypto wallet",
				detail: "Digital dollars (USDC) to your own wallet",
				icon: "wallet",
			}
		case "crypto_custodial":
			return {
				title: "Custodial wallet",
				detail: "A test wallet we hold for you",
				icon: "shield",
			}
	}
}

const detailLabel = (
	type: DestinationType,
	network: "stellar" | "solana",
): string => {
	if (isCrypto(type)) {
		return network === "solana"
			? "Solana wallet address (devnet USDC)"
			: "Stellar testnet wallet address"
	}
	if (type === "ewallet") return "E-wallet number"
	return "Bank account number"
}

const detailPlaceholder = (
	type: DestinationType,
	network: "stellar" | "solana",
): string =>
	isCrypto(type)
		? network === "solana"
			? "Base58 address…"
			: "G…"
		: "Account details"

const formatAmount = (
	amount: string,
	currency: string,
): { value: string; currency: string | null } => {
	if (isPoundDisplayCurrency(currency)) {
		return { value: displayMoney(amount, currency), currency: null }
	}
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
	if (status === "accepted") return "accepted"
	if (status === "expired") return "expired"
	return "open"
}

const paymentStatusLabel = (status: string): string =>
	PAYMENT_STATUS_LABELS[status] ?? status

const closedClaimMessage = (claim: ClaimView): string => {
	if (claim.status === "expired") {
		return CLAIM_EXPIRED_ASK_SENDER
	}
	if (claim.paymentStatus === "paid") {
		if (claim.releaseEvidence?.network === "solana") {
			return "Paid. We checked the Solana transfer on-chain before marking it paid."
		}
		return "Paid. We have confirmed your money was released."
	}
	if (claim.paymentStatus === "failed") {
		return "This payment did not go through, so nothing was marked as paid."
	}
	if (CLOSED_PAYMENT_STATUSES.has(claim.paymentStatus)) {
		return `This payment is now: ${paymentStatusLabel(claim.paymentStatus)}. It has not been paid to you.`
	}
	return "We are waiting for the sender's money to reach you. This page updates by itself, so you can leave it open."
}

const closedClaimTitle = (claim: ClaimView): string => {
	if (claim.status === "expired") return "This link has expired"
	if (claim.paymentStatus === "paid") return "Money delivered"
	if (claim.paymentStatus === "failed") return "This payment didn't go through"
	if (CLOSED_PAYMENT_STATUSES.has(claim.paymentStatus))
		return "This payment was stopped"
	return "You're all set"
}

const notReadyMessage = (claim: ClaimView): string => {
	if (
		claim.paymentStatus === "quoted" ||
		claim.paymentStatus === "awaiting_funding"
	) {
		return "The sender hasn't paid this in yet. Ask them to pay it, then come back to accept."
	}
	if (claim.paymentStatus === "funded") {
		return "The sender has paid in, but this is not ready to accept yet. Check back in a minute."
	}
	return `This can't be accepted while the payment is: ${paymentStatusLabel(claim.paymentStatus)}.`
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
	const live = useLiveMoney()
	const [claim, setClaim] = useState<ClaimView | null>(null)
	const [loading, setLoading] = useState(true)
	const [loadError, setLoadError] = useState<ClaimApiError | null>(null)
	const [pollError, setPollError] = useState<string | null>(null)
	const [reloadKey, setReloadKey] = useState(0)
	const [selectedType, setSelectedType] = useState<DestinationType | "">("")
	const [detail, setDetail] = useState("")
	// Default Stellar so existing claim flows keep the Stellar address field;
	// Solana is an explicit opt-in on the claim form.
	const [cryptoNetwork, setCryptoNetwork] = useState<"stellar" | "solana">(
		"stellar",
	)
	const [accepting, setAccepting] = useState(false)
	const [acceptError, setAcceptError] = useState<string | null>(null)
	const [expired, setExpired] = useState(false)
	const [solanaConnected, setSolanaConnected] =
		useState<ConnectedSolanaWallet | null>(null)
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
		setSelectedType(type)
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
			network: isCrypto(selectedType) ? cryptoNetwork : undefined,
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

	const isOpen = claim?.status === "open"
	const step2Ready = Boolean(selectedType)
	const doneTone = claim ? closedClaimTone(claim) : "info"
	const doneIcon: IconName =
		claim?.paymentStatus === "paid"
			? "check"
			: doneTone === "warning"
				? "alert"
				: "clock"

	return (
		<main className="claim-page">
			<div className="claim-page__inner">
				<header className="claim-top">
					<span className="claim-brand">
						<span className="claim-brand__mark" aria-hidden="true">
							<Icon name="bolt" size={18} />
						</span>
						<span className="claim-brand__text">
							<span className="claim-brand__name">FlexiPay</span>
							<span className="claim-brand__by">by FlexiWork</span>
						</span>
					</span>
					<SimulatedLabel />
				</header>

				<section
					className={`claim-hero${claim ? "" : " claim-hero--empty"}`}
					aria-labelledby="claim-title"
				>
					<p className="claim-hero__eyebrow">
						<Icon name="gift" size={15} />
						{claim ? "You've got money" : "Payment from Demo Platform"}
					</p>
					<h1 className="claim-hero__title" id="claim-title">
						Claim your payment
					</h1>

					{claim && amount ? (
						<>
							<p className="claim-hero__amount">
								<span className="claim-hero__value" data-testid="claim-amount">
									{amount.value}
								</span>
								{amount.currency ? (
									<span className="claim-hero__currency">
										{amount.currency}
									</span>
								) : null}
							</p>
							<p className="claim-hero__from">
								From <strong>Demo Platform</strong>
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

							<div className="claim-meta" data-testid="claim-expiry">
								<p className="claim-meta__chip">
									<Icon name="globe" size={14} />
									{claim.corridor.from.country} → {claim.corridor.to.country} ·{" "}
									{claim.corridor.to.currency}
								</p>
								{(() => {
									const until = formatClaimValidUntil(claim.expiresAt)
									const remaining = aboutDaysLeft(claim.expiresAt)
									if (claim.status === "accepted") return null
									if (claim.status === "expired" || expired) {
										return (
											<p
												className="claim-meta__chip claim-meta__chip--bad"
												data-testid="claim-expiry-expired"
											>
												<Icon name="clock" size={14} />
												Expired (was valid until {until}). Ask the sender for a
												new link.
											</p>
										)
									}
									return (
										<p
											className="claim-meta__chip"
											data-testid="claim-expiry-open"
										>
											<Icon name="clock" size={14} />
											Valid until {until}
											{remaining ? ` · ${remaining}` : ""}.
										</p>
									)
								})()}
							</div>
						</>
					) : null}
				</section>

				<p className="claim-testnote">
					<Icon name="shield" size={14} />
					{live
						? "This payment uses live money on Solana mainnet."
						: "Test mode: bank and e-wallet payouts are simulated. Solana devnet only; no real money moves."}
				</p>

				{loading ? (
					<div className="claim-card claim-loading" role="status">
						<span className="claim-spinner" aria-hidden="true" />
						Loading claim…
					</div>
				) : null}

				{loadError && !claim ? (
					<div className="claim-card claim-problem">
						<span className="claim-problem__icon" aria-hidden="true">
							<Icon name="link" size={26} />
						</span>
						<h2 className="claim-problem__title">
							We couldn&apos;t open this link
						</h2>
						<p className="claim-problem__text">{loadError.message}</p>
						<p className="claim-problem__hint">
							Check you used the whole link, or ask the person who sent it for a
							new one.
						</p>
						<Button
							variant="secondary"
							onClick={() => setReloadKey((value) => value + 1)}
						>
							Try again
						</Button>
					</div>
				) : null}

				{claim && isOpen ? (
					<div className="claim-steps">
						<section className="claim-card claim-step">
							<h2 className="claim-step__title">
								<span className="claim-step__num" aria-hidden="true">
									1
								</span>
								How do you want your money?
							</h2>
							<fieldset className="claim-choices">
								<legend className="visually-hidden">Receive to</legend>
								{claim.allowedDestinationTypes.map((type) => {
									const copy = optionCopy(type)
									const supported = supportsClaimAccept(type)
									return (
										<label
											className={`claim-choice${supported ? "" : " claim-choice--off"}`}
											key={type}
										>
											<input
												type="radio"
												name="receive"
												value={type}
												checked={selectedType === type}
												disabled={accepting || expired || !supported}
												onChange={() => updateSelection(type)}
											/>
											<span className="claim-choice__icon" aria-hidden="true">
												<Icon name={copy.icon} size={24} />
											</span>
											<span className="claim-choice__body">
												<span className="claim-choice__title">
													{copy.title}
												</span>{" "}
												<span className="claim-choice__detail">
													{supported
														? copy.detail
														: "Not available for this claim."}
												</span>
											</span>
											<span className="claim-choice__tick" aria-hidden="true">
												<Icon name="check" size={16} />
											</span>
										</label>
									)
								})}
							</fieldset>
						</section>

						{step2Ready && selectedType ? (
							<section className="claim-card claim-step claim-detail">
								<h2 className="claim-step__title">
									<span className="claim-step__num" aria-hidden="true">
										2
									</span>
									{isCrypto(selectedType)
										? "Which wallet should get it?"
										: selectedType === "ewallet"
											? "What's your e-wallet number?"
											: "Where should we send it?"}
								</h2>
								{isCrypto(selectedType) ? (
									<fieldset
										className="claim-networks"
										data-testid="claim-crypto-network"
									>
										<legend className="claim-networks__legend">
											Pick your wallet&apos;s network
										</legend>
										<label className="claim-network">
											<input
												type="radio"
												name="crypto-network"
												checked={cryptoNetwork === "solana"}
												disabled={accepting || expired}
												onChange={() => {
													setCryptoNetwork("solana")
													setDetail("")
													setSolanaConnected(null)
													idempotencyKey.current = null
												}}
											/>
											<span className="claim-network__body">
												<span className="claim-network__title">
													Solana USDC (devnet test)
												</span>{" "}
												<span className="claim-network__detail">
													Phantom, Solflare and similar. Test network only.
												</span>
											</span>
										</label>
										<label className="claim-network">
											<input
												type="radio"
												name="crypto-network"
												checked={cryptoNetwork === "stellar"}
												disabled={accepting || expired}
												onChange={() => {
													setCryptoNetwork("stellar")
													setDetail("")
													setSolanaConnected(null)
													idempotencyKey.current = null
												}}
											/>
											<span className="claim-network__body">
												<span className="claim-network__title">
													Stellar testnet
												</span>{" "}
												<span className="claim-network__detail">
													Stellar wallets. Test network only.
												</span>
											</span>
										</label>
									</fieldset>
								) : null}
								{isCrypto(selectedType) && cryptoNetwork === "solana" ? (
									<div className="claim-solana">
										<SolanaWalletPanel
											title="Connect your Solana wallet"
											onConnected={(session: ConnectedSolanaWallet | null) => {
												setSolanaConnected(session)
												if (!session) return
												updateDetail(session.address)
											}}
										/>
										<p className="claim-fine">
											Bank and e-wallet payouts are not labelled LIVE without a
											verified provider.
										</p>
									</div>
								) : null}
								<TextField
									id="claim-detail"
									label={detailLabel(selectedType, cryptoNetwork)}
									placeholder={detailPlaceholder(selectedType, cryptoNetwork)}
									autoComplete="off"
									value={detail}
									disabled={accepting || expired}
									onChange={(event) => updateDetail(event.target.value)}
									hint={
										isCrypto(selectedType)
											? cryptoNetwork === "solana"
												? "Connect your wallet or paste its public address. Never share a secret key or recovery phrase."
												: "Paste your public wallet address. Never share a secret key or recovery phrase."
											: "Only these details are shared to pay you."
									}
								/>
								{selectedType === "crypto_wallet" &&
								cryptoNetwork === "solana" &&
								!solanaConnected ? (
									<NoWalletYetHelp />
								) : null}
							</section>
						) : null}

						<section className="claim-card claim-step claim-step--action">
							<h2 className="claim-step__title">
								<span className="claim-step__num" aria-hidden="true">
									{step2Ready ? 3 : 2}
								</span>
								Get your money
							</h2>
							{expired ? (
								<Notice tone="warning" data-testid="claim-expired-notice">
									{CLAIM_EXPIRED_ASK_SENDER}
								</Notice>
							) : null}
							{!paymentAcceptable ? (
								<Notice tone="warning">{notReadyMessage(claim)}</Notice>
							) : null}
							{acceptError ? (
								<Notice tone="warning" data-testid="claim-accept-error">
									{acceptError}
								</Notice>
							) : null}
							{hasSupportedType ? (
								<>
									<Button
										className="claim-accept"
										onClick={() => void handleAccept()}
										disabled={!canAccept}
										data-testid="claim-accept"
									>
										{accepting ? "Accepting…" : "Accept payment"}
									</Button>
									<p className="claim-fine claim-fine--center">
										<Icon name="lock" size={13} />
										{!selectedType
											? "Choose how you want your money to continue."
											: !detail.trim()
												? "Add your details above to continue."
												: "We only use these details to pay you."}
									</p>
								</>
							) : (
								<Notice tone="warning">
									This claim can&apos;t be accepted here yet. Ask the sender for
									help.
								</Notice>
							)}
						</section>
					</div>
				) : null}

				{claim && !isOpen ? (
					<>
						<section
							className={`claim-card claim-done claim-done--${claim.paymentStatus === "paid" ? "ok" : doneTone}`}
							data-testid="claim-closed-status"
							role="status"
						>
							<span className="claim-done__icon" aria-hidden="true">
								<Icon name={doneIcon} size={30} />
							</span>
							<h2 className="claim-done__title">{closedClaimTitle(claim)}</h2>
							<p className="claim-done__text">{closedClaimMessage(claim)}</p>
							{claim.status === "accepted" &&
							!TERMINAL_PAYMENT_STATUSES.has(claim.paymentStatus) ? (
								<span className="claim-done__pulse" aria-hidden="true">
									<span />
									<span />
									<span />
								</span>
							) : null}
						</section>
						{claim.paymentStatus === "paid" && claim.releaseEvidence ? (
							<section
								className="claim-card claim-proof"
								data-testid="claim-release-evidence"
							>
								<p className="claim-proof__title">
									<Icon name="shield" size={16} />
									Proof of payment · verified on{" "}
									{claim.releaseEvidence.network === "solana"
										? "Solana"
										: claim.releaseEvidence.network}
								</p>
								<CopyableValue
									value={claim.releaseEvidence.signature}
									label="Copy signature"
									data-testid="claim-release-signature"
								/>
								{claim.releaseEvidence.explorerUrl ? (
									<a
										className="claim-proof__link"
										href={claim.releaseEvidence.explorerUrl}
										target="_blank"
										rel="noreferrer"
										data-testid="claim-explorer-link"
									>
										View on Explorer
										<Icon name="arrow" size={14} />
									</a>
								) : null}
							</section>
						) : null}
					</>
				) : null}

				{pollError ? <Notice tone="warning">{pollError}</Notice> : null}

				{claim ? (
					<details className="claim-details" data-testid="claim-details">
						<summary>Details</summary>
						<div className="claim-details__body">
							<p>
								The amount is the expected receive side from the payment quote.
								Fee and net are not fields of the public claim view; no fee is
								computed in the browser.
							</p>
							<p>
								Every payout option uses the claim accept API; fiat payouts stay
								simulated in test mode.
							</p>
							<p>
								Accepting sends one idempotent request. For Solana, accept only
								locks your destination; it is marked paid after the
								sender&apos;s transfer is verified on-chain.
							</p>
						</div>
					</details>
				) : null}

				<footer className="claim-foot">
					<Icon name="lock" size={13} />
					Secure payment link · FlexiPay by FlexiWork
				</footer>
			</div>
		</main>
	)
}
