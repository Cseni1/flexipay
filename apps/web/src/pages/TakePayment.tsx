import { useEffect, useRef, useState, type FormEvent } from "react"
import { ApiError, describeApiError, isAuthRequired } from "../api/client"
import {
	createPaymentRequest,
	getPaymentRequest,
	type PaymentRequest,
} from "../api/paymentRequests"
import { AuthBlockedNotice } from "../components/AuthBlockedNotice"
import { QrCode } from "../components/QrCode"
import { SolanaWalletPanel } from "../components/solana/SolanaWalletPanel"
import {
	Button,
	Notice,
	Page,
	PageHeader,
	SimulatedLabel,
	TextField,
} from "../components/ui"
import { Icon } from "../components/ui/Icon"
import { useCountdown } from "../hooks/useCountdown"
import { formatLocalDateTime } from "../payments/formatPaymentTime"
import { displayMoney } from "../payments/quoteDisplay"
import {
	isValidMerchantWallet,
	normalizeTillLabel,
	parseTillAmountPounds,
} from "../payments/tillAmount"
import {
	clearTillMerchant,
	loadTillMerchant,
	saveTillMerchant,
} from "../payments/tillMerchantStorage"
import {
	shortAddress,
	type ConnectedSolanaWallet,
} from "../solana/walletStandard"
import "../styles/pages/getpaid.css"

const POLL_MS = 2_000

/** One-tap amounts for the till (pounds). */
const QUICK_AMOUNTS = ["5", "10", "20", "50"] as const

/** Stable ids so labels stay tied to inputs (Playwright getByLabel / a11y). */
const FIELD_IDS = {
	amount: "till-amount",
	wallet: "till-wallet",
	label: "till-label",
} as const

type Phase = "form" | "waiting" | "paid" | "expired"

export default function TakePayment() {
	const [amount, setAmount] = useState("")
	const [wallet, setWallet] = useState("")
	const [label, setLabel] = useState("")
	const [hasSavedMerchant, setHasSavedMerchant] = useState(false)
	const [connected, setConnected] = useState<ConnectedSolanaWallet | null>(null)
	const [formError, setFormError] = useState<string | null>(null)
	const [authBlocked, setAuthBlocked] = useState(false)
	const [creating, setCreating] = useState(false)
	const [request, setRequest] = useState<PaymentRequest | null>(null)
	const [phase, setPhase] = useState<Phase>("form")
	const [printMode, setPrintMode] = useState(false)
	const [paidAt, setPaidAt] = useState<string | null>(null)
	const createLock = useRef(false)
	const pollAbort = useRef<AbortController | null>(null)
	const pollCount = useRef(0)

	const countdown = useCountdown(
		phase === "waiting" ? (request?.expiresAt ?? null) : null,
	)

	useEffect(() => {
		const saved = loadTillMerchant()
		if (!saved) return
		setWallet(saved.wallet)
		setLabel(saved.label)
		setHasSavedMerchant(true)
	}, [])

	useEffect(() => {
		if (connected?.address && !wallet.trim()) {
			setWallet(connected.address)
		}
	}, [connected, wallet])

	useEffect(() => {
		document.documentElement.classList.toggle("till-print", printMode)
		return () => document.documentElement.classList.remove("till-print")
	}, [printMode])

	const requestId = request?.id ?? null

	useEffect(() => {
		if (phase !== "waiting" || !requestId) return
		pollAbort.current?.abort()
		const controller = new AbortController()
		pollAbort.current = controller
		let timer: number | undefined
		let stopped = false
		pollCount.current = 0

		const tick = async () => {
			try {
				pollCount.current += 1
				const next = await getPaymentRequest(requestId, controller.signal)
				if (stopped || controller.signal.aborted) return
				setRequest(next)
				if (next.status === "paid") {
					setPaidAt((prev) => prev ?? new Date().toISOString())
					setPhase("paid")
					setPrintMode(false)
					return
				}
				if (next.status === "expired") {
					setPhase("expired")
					setPrintMode(false)
					return
				}
				timer = window.setTimeout(() => void tick(), POLL_MS)
			} catch (cause) {
				if (stopped || controller.signal.aborted) return
				if (isAuthRequired(cause)) setAuthBlocked(true)
				timer = window.setTimeout(() => void tick(), POLL_MS)
			}
		}

		timer = window.setTimeout(() => void tick(), POLL_MS)
		return () => {
			stopped = true
			controller.abort()
			if (timer !== undefined) window.clearTimeout(timer)
		}
	}, [phase, requestId])

	useEffect(() => {
		if (phase === "waiting" && countdown.expired && request) {
			setPhase("expired")
			setPrintMode(false)
		}
	}, [phase, countdown.expired, request])

	const resetToForm = () => {
		pollAbort.current?.abort()
		setPaidAt(null)
		setRequest(null)
		setPhase("form")
		setPrintMode(false)
		setFormError(null)
		setCreating(false)
		createLock.current = false
		setAmount("")
	}

	const forgetSavedMerchant = () => {
		clearTillMerchant()
		setHasSavedMerchant(false)
		setWallet("")
		setLabel("")
	}

	const handleCreate = async (event: FormEvent) => {
		event.preventDefault()
		if (createLock.current || authBlocked) return

		const minors = parseTillAmountPounds(amount)
		if (minors === null) {
			setFormError(
				"Enter an amount from £1.00 to £10,000.00 (at most two decimals).",
			)
			return
		}
		const merchantWallet = wallet.trim()
		if (!isValidMerchantWallet(merchantWallet)) {
			setFormError("Enter a Solana wallet address (base58, 32–44 characters).")
			return
		}
		const normalizedLabel = normalizeTillLabel(label)
		if (normalizedLabel === null) {
			setFormError("Label must be at most 40 characters.")
			return
		}

		createLock.current = true
		setCreating(true)
		setFormError(null)
		try {
			const created = await createPaymentRequest({
				amount: minors,
				merchantWallet,
				...(normalizedLabel !== undefined ? { label: normalizedLabel } : {}),
			})
			saveTillMerchant({
				wallet: merchantWallet,
				label: normalizedLabel ?? "",
			})
			setHasSavedMerchant(true)
			setRequest(created)
			if (created.status === "paid") {
				setPaidAt(new Date().toISOString())
				setPhase("paid")
			} else {
				setPhase("waiting")
			}
		} catch (cause) {
			if (isAuthRequired(cause)) setAuthBlocked(true)
			setFormError(
				cause instanceof ApiError
					? describeApiError(cause)
					: "Could not create the payment request.",
			)
		} finally {
			setCreating(false)
			createLock.current = false
		}
	}

	const amountLabel = request
		? displayMoney(request.amount.amount, request.amount.currency)
		: null

	return (
		<Page>
			<div className="till-page" data-testid="till-page">
				<PageHeader
					eyebrow="Till"
					title="Get paid"
					description="Type the amount, show the QR code, and your customer pays you straight from their phone."
					actions={<SimulatedLabel />}
				/>

				{authBlocked ? <AuthBlockedNotice /> : null}

				<p
					className="form-note till-devnet-note"
					data-testid="till-devnet-note"
				>
					<Icon name="shield" size={14} />
					Test mode: devnet tGBP. The customer&apos;s wallet must be set to
					devnet.
				</p>

				{phase === "form" ? (
					<div className="gp-form">
						<form
							id="till-form"
							className="gp-card gp-amount"
							onSubmit={(event) => void handleCreate(event)}
						>
							<p className="gp-card__kicker">
								<span className="gp-step">1</span>
								How much?
							</p>
							<div className="gp-amount__field">
								<span className="gp-amount__pound" aria-hidden="true">
									£
								</span>
								<TextField
									id={FIELD_IDS.amount}
									name="tillAmount"
									label="Amount (£)"
									placeholder="0.00"
									inputMode="decimal"
									autoComplete="off"
									value={amount}
									hint="From £1 to £10,000."
									disabled={authBlocked}
									className="gp-amount__input"
									onChange={(event) => setAmount(event.target.value)}
								/>
							</div>
							<div className="gp-quick" role="group" aria-label="Quick amounts">
								{QUICK_AMOUNTS.map((value) => (
									<button
										key={value}
										type="button"
										className={`gp-quick__chip${amount === value ? " is-on" : ""}`}
										disabled={authBlocked}
										onClick={() => setAmount(value)}
									>
										£{value}
									</button>
								))}
							</div>
						</form>

						<section className="gp-card gp-wallet" aria-labelledby="gp-to">
							<p className="gp-card__kicker" id="gp-to">
								<span className="gp-step">2</span>
								Where the money goes
							</p>
							<div className="gp-wallet__fields">
								<TextField
									id={FIELD_IDS.wallet}
									form="till-form"
									name="merchantWallet"
									label="Merchant wallet"
									placeholder="Your Solana wallet address"
									value={wallet}
									hint={
										connected
											? `Filled in from ${shortAddress(connected.address)}. You can change it.`
											: "Connect your wallet below, or paste its address."
									}
									autoComplete="off"
									disabled={authBlocked}
									onChange={(event) => setWallet(event.target.value)}
								/>
								<TextField
									id={FIELD_IDS.label}
									form="till-form"
									name="tillLabel"
									label="Label"
									placeholder="Table 4"
									value={label}
									hint="Optional. Your customer sees it in their wallet."
									disabled={authBlocked}
									onChange={(event) => setLabel(event.target.value)}
								/>
							</div>
							{hasSavedMerchant ? (
								<p className="gp-saved">
									<Icon name="check" size={14} />
									Saved on this device.{" "}
									<button
										type="button"
										className="linkish"
										data-testid="till-forget-merchant"
										onClick={forgetSavedMerchant}
									>
										Forget saved wallet
									</button>
								</p>
							) : null}
							<details className="gp-connect till-wallet-panel">
								<summary>
									<Icon name="wallet" size={16} />
									Connect a wallet instead
								</summary>
								<SolanaWalletPanel
									title="Connect Solana (optional)"
									onConnected={setConnected}
								/>
							</details>
						</section>

						<div className="gp-action">
							{formError ? (
								<Notice tone="warning" data-testid="till-form-error">
									{formError}
								</Notice>
							) : null}
							<Button
								type="submit"
								form="till-form"
								className="gp-create"
								disabled={creating || authBlocked}
							>
								<Icon name="qr" size={20} />
								{creating ? "Creating…" : "Create QR"}
							</Button>
						</div>
					</div>
				) : null}

				{phase === "waiting" && request && amountLabel ? (
					<div data-testid="till-waiting" className="gp-waiting-wrap">
						<section className="gp-card gp-waiting">
							<div className="till-waiting">
								<div className="till-qr-stack">
									<p className="gp-waiting__kicker">Scan to pay</p>
									<p
										className="till-waiting__amount"
										data-testid="till-waiting-amount"
									>
										{amountLabel}
									</p>
									{label.trim() ? (
										<p className="gp-waiting__label">{label.trim()}</p>
									) : null}
									<div className="till-qr" data-testid="till-qr">
										<QrCode
											value={request.solanaPayUrl}
											label="Solana Pay QR"
											size={printMode ? 420 : 320}
										/>
									</div>
									<p className="till-waiting__status" role="status">
										<span className="gp-live-dot" aria-hidden="true" />
										Waiting for payment…
									</p>
								</div>
								<dl className="till-waiting__meta">
									<div>
										<dt>Expires in</dt>
										<dd>{countdown.expired ? "Expired" : countdown.label}</dd>
									</div>
									<div>
										<dt>Paid to</dt>
										<dd>
											<code className="code-text">
												{shortAddress(request.merchantWallet)}
											</code>
										</dd>
									</div>
								</dl>
							</div>
							<div className="form-actions gp-waiting__actions">
								<Button
									type="button"
									variant="secondary"
									onClick={() => setPrintMode((value) => !value)}
									data-testid="till-print-toggle"
								>
									<Icon name={printMode ? "close" : "print"} size={18} />
									{printMode ? "Exit full screen" : "Print / full screen"}
								</Button>
								<Button
									type="button"
									variant="ghost"
									className="no-print"
									onClick={resetToForm}
								>
									Cancel
								</Button>
							</div>
						</section>
					</div>
				) : null}

				{phase === "paid" && request && amountLabel ? (
					<div
						className="till-paid-screen"
						data-testid="till-paid"
						role="dialog"
						aria-modal="true"
						aria-labelledby="till-paid-heading"
					>
						<div className="till-paid-screen__card">
							<span className="till-paid-screen__tick" aria-hidden="true">
								<Icon name="check" size={44} />
							</span>
							<p className="till-paid-screen__eyebrow">Payment received</p>
							<h2
								className="till-paid-screen__amount"
								id="till-paid-heading"
								data-testid="till-paid-confirm"
							>
								{amountLabel} received
							</h2>
							{paidAt ? (
								<p
									className="till-paid-screen__meta"
									data-testid="till-paid-at"
								>
									{formatLocalDateTime(paidAt)}
								</p>
							) : null}
							{request.payer ? (
								<p
									className="till-paid-screen__meta"
									data-testid="till-paid-payer"
								>
									From{" "}
									<code className="code-text" title={request.payer}>
										{shortAddress(request.payer)}
									</code>
								</p>
							) : (
								<p className="till-paid-screen__meta muted">
									Payer wallet not reported on this request.
								</p>
							)}
							{request.explorerUrl ? (
								<p className="till-paid-screen__meta">
									<a
										href={request.explorerUrl}
										target="_blank"
										rel="noreferrer"
										data-testid="till-explorer"
									>
										View on Solana Explorer
									</a>
								</p>
							) : null}
							<div className="form-actions">
								<Button
									type="button"
									onClick={resetToForm}
									data-testid="till-paid-done"
								>
									Done
								</Button>
							</div>
						</div>
					</div>
				) : null}

				{phase === "expired" ? (
					<div className="till-expired gp-card" data-testid="till-expired">
						<span className="till-expired__icon" aria-hidden="true">
							<Icon name="clock" size={30} />
						</span>
						<p className="till-expired__title">This QR code has expired</p>
						<p className="till-expired__text">
							No money was taken. Make a new one to try again.
						</p>
						<div className="form-actions">
							<Button type="button" onClick={resetToForm}>
								New request
							</Button>
						</div>
					</div>
				) : null}
			</div>
		</Page>
	)
}
