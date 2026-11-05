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
	Panel,
	SimulatedLabel,
	StaticField,
	TextField,
} from "../components/ui"
import { useCountdown } from "../hooks/useCountdown"
import { displayMoney } from "../payments/quoteDisplay"
import {
	isValidMerchantWallet,
	normalizeTillLabel,
	parseTillAmountPounds,
} from "../payments/tillAmount"
import {
	shortAddress,
	type ConnectedSolanaWallet,
} from "../solana/walletStandard"

const POLL_MS = 2_000

type Phase = "form" | "waiting" | "paid" | "expired"

export default function TakePayment() {
	const [amount, setAmount] = useState("")
	const [wallet, setWallet] = useState("")
	const [label, setLabel] = useState("")
	const [connected, setConnected] = useState<ConnectedSolanaWallet | null>(null)
	const [formError, setFormError] = useState<string | null>(null)
	const [authBlocked, setAuthBlocked] = useState(false)
	const [creating, setCreating] = useState(false)
	const [request, setRequest] = useState<PaymentRequest | null>(null)
	const [phase, setPhase] = useState<Phase>("form")
	const [printMode, setPrintMode] = useState(false)
	const createLock = useRef(false)
	const pollAbort = useRef<AbortController | null>(null)

	const countdown = useCountdown(
		phase === "waiting" ? (request?.expiresAt ?? null) : null,
	)

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

		const tick = async () => {
			try {
				const next = await getPaymentRequest(requestId, controller.signal)
				if (stopped || controller.signal.aborted) return
				setRequest(next)
				if (next.status === "paid") {
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
		setRequest(null)
		setPhase("form")
		setPrintMode(false)
		setFormError(null)
		setCreating(false)
		createLock.current = false
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
			setRequest(created)
			setPhase(created.status === "paid" ? "paid" : "waiting")
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
			<PageHeader
				eyebrow="Till"
				title="Take payment"
				description="Create a Solana Pay QR for tGBP. The customer pays wallet to wallet; FlexiPay does not hold the funds."
				actions={<SimulatedLabel />}
			/>

			{authBlocked ? <AuthBlockedNotice /> : null}

			<p className="form-note till-devnet-note" data-testid="till-devnet-note">
				Test mode: devnet tGBP. The customer&apos;s wallet must be set to
				devnet.
			</p>

			{phase === "form" ? (
				<Panel
					title="New request"
					description="Amount is what you receive in pounds. Collect and fee steps stay simulated."
					actions={<SimulatedLabel />}
				>
					<form onSubmit={(event) => void handleCreate(event)}>
						<div className="form-grid">
							<TextField
								id="till-amount"
								label="Amount (£)"
								placeholder="10.00"
								inputMode="decimal"
								value={amount}
								hint="£1.00 to £10,000.00 · at most two decimals."
								disabled={authBlocked}
								onChange={(event) => setAmount(event.target.value)}
							/>
							<TextField
								id="till-wallet"
								label="Merchant wallet"
								placeholder="Base58 Solana address…"
								value={wallet}
								hint={
									connected
										? `Pre-filled from ${shortAddress(connected.address)}. You can edit it.`
										: "Connect a wallet below or paste a base58 address (32–44 characters)."
								}
								autoComplete="off"
								disabled={authBlocked}
								onChange={(event) => setWallet(event.target.value)}
							/>
							<TextField
								id="till-label"
								label="Label (optional)"
								placeholder="Table 4"
								value={label}
								hint="Shown in the customer's wallet · max 40 characters."
								disabled={authBlocked}
								onChange={(event) => setLabel(event.target.value)}
							/>
						</div>
						{formError ? (
							<Notice tone="warning" data-testid="till-form-error">
								{formError}
							</Notice>
						) : null}
						<div className="form-actions">
							<Button type="submit" disabled={creating || authBlocked}>
								{creating ? "Creating…" : "Create QR"}
							</Button>
						</div>
					</form>
					<div className="till-wallet-panel">
						<SolanaWalletPanel
							title="Merchant wallet (optional)"
							onConnected={setConnected}
						/>
					</div>
				</Panel>
			) : null}

			{phase === "waiting" && request && amountLabel ? (
				<div data-testid="till-waiting">
					<Panel
						title="Waiting for payment…"
						description="Show this QR to the customer. Status updates every few seconds."
						actions={<SimulatedLabel />}
					>
						<div className="till-waiting">
							<div className="till-qr" data-testid="till-qr">
								<QrCode
									value={request.solanaPayUrl}
									label="Solana Pay QR"
									size={printMode ? 420 : 260}
								/>
							</div>
							<div className="till-waiting__meta">
								<StaticField label="Amount" value={amountLabel} />
								<StaticField
									label="Merchant wallet"
									value={shortAddress(request.merchantWallet)}
								/>
								<StaticField
									label="Expires in"
									value={countdown.expired ? "Expired" : countdown.label}
								/>
								<p className="form-note" role="status">
									Waiting for payment…
								</p>
							</div>
						</div>
						<div className="form-actions no-print">
							<Button
								type="button"
								variant="secondary"
								onClick={() => setPrintMode((value) => !value)}
								data-testid="till-print-toggle"
							>
								{printMode ? "Exit full screen" : "Print / full screen"}
							</Button>
							<Button type="button" variant="secondary" onClick={resetToForm}>
								Cancel
							</Button>
						</div>
					</Panel>
				</div>
			) : null}

			{phase === "paid" && request && amountLabel ? (
				<div className="till-paid" data-testid="till-paid">
					<p className="till-paid__title">Paid {amountLabel}</p>
					{request.explorerUrl ? (
						<p>
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
						<Button type="button" onClick={resetToForm}>
							New request
						</Button>
					</div>
				</div>
			) : null}

			{phase === "expired" ? (
				<div className="till-expired" data-testid="till-expired">
					<p className="till-expired__title">Expired, create a new request</p>
					<div className="form-actions">
						<Button type="button" onClick={resetToForm}>
							New request
						</Button>
					</div>
				</div>
			) : null}
		</Page>
	)
}
