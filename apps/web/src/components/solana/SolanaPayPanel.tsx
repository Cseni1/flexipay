import {
	buildUsdcTransferTransaction,
	getSolAndUsdcBalances,
} from "@flexipay/adapter-solana/browser"
import {
	lazy,
	Suspense,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from "react"
import {
	ApiError,
	isTransientApiError,
	newIdempotencyKey,
} from "../../api/client"
import {
	confirmSolanaTransfer,
	getSolanaConfig,
	getSolanaIntent,
	type SolanaConfirmOk,
	type SolanaIntent,
} from "../../api/solanaClient"
import {
	isFlexiPayWalletConfigured,
	readPrivyAppId,
} from "../../flexipayWallet/config"
import {
	sendFlexiPaySolanaTransaction,
	type FlexiPaySolanaWallet,
} from "../../flexipayWallet/sendFlexiPaySolanaTransaction"
import { formatLocalClock } from "../../payments/formatPaymentTime"
import { isSolanaSettleRail } from "../../payments/solanaRails"
import {
	clearSolanaTransfer,
	loadSolanaTransfer,
	saveSolanaTransfer,
	type SolanaTransferMemory,
} from "../../payments/solanaTransferStorage"
import {
	assetLabel,
	formatAssetAmount,
	type SolanaAsset,
} from "../../solana/assets"
import {
	friendlySolanaPayError,
	SOLANA_PAY_ERROR_COPY,
} from "../../solana/friendlySolanaPayError"
import {
	accountSupportsCluster,
	Connection,
	signAndSendSolanaTransaction,
	walletSupportsCluster,
	type ConnectedSolanaWallet,
} from "../../solana/walletStandard"
import { Button, Notice, Panel, StaticField } from "../ui"
import { FlexiPayWalletPayButton } from "./FlexiPayWalletPayButton"
import { SolanaTxSuccess } from "./SolanaTxSuccess"
import { SolanaWalletPanel } from "./SolanaWalletPanel"

type Props = {
	paymentId: string
	onPaid?: (result: SolanaConfirmOk) => void
	/** Settle rail from payment detail — keeps the panel visible for GB→abroad Solana wait. */
	settleRail?: string
	/** Settle leg amountOut when intent is not yet readable (claim-gated API). */
	settleAmount?: { amount: string; currency: string }
	/**
	 * CCR-39: direct settle-to-treasury shows as "FlexiPay settlement account"
	 * instead of a recipient wallet.
	 */
	recipientFieldLabel?: string
}

const assetFromCurrency = (currency: string): SolanaAsset | null => {
	if (currency === "TGBP") return "TGBP"
	if (currency === "USDC") return "USDC"
	return null
}

/** Domain TGBP/USDC use 7 minor decimals; mint intents usually report 6. */
const DOMAIN_ASSET_DECIMALS = 7

/** Rough lower bound so the wallet can pay a simple SPL transfer fee on devnet. */
const MIN_SOL_LAMPORTS_FOR_FEES = 5_000n

const CONFIRM_BUDGET_MS = 90_000
const CONFIRM_DELAY_START_MS = 1_500
const CONFIRM_DELAY_MAX_MS = 5_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const shouldKeepConfirming = (cause: unknown): boolean => {
	if (cause instanceof ApiError) {
		if (cause.status === 202 || cause.code === "pending") return true
		return isTransientApiError(cause)
	}
	return cause instanceof TypeError
}

const FlexiPayPayProviders = lazy(async () => {
	const { FlexiPayWalletProviders } =
		await import("../../flexipayWallet/FlexiPayWalletProviders")
	function Loaded({ children }: { children: ReactNode }) {
		const appId = readPrivyAppId(import.meta.env)
		if (!appId) return null
		return (
			<FlexiPayWalletProviders appId={appId}>
				{children}
			</FlexiPayWalletProviders>
		)
	}
	return { default: Loaded }
})

export function SolanaPayPanel({
	paymentId,
	onPaid,
	settleRail,
	settleAmount,
	recipientFieldLabel = "Recipient",
}: Props) {
	const [intent, setIntent] = useState<SolanaIntent | null>(null)
	const [notSolanaSettle, setNotSolanaSettle] = useState(false)
	const [connected, setConnected] = useState<ConnectedSolanaWallet | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [verifying, setVerifying] = useState(false)
	const [result, setResult] = useState<SolanaConfirmOk | null>(null)
	const [stored, setStored] = useState<SolanaTransferMemory | null>(() =>
		loadSolanaTransfer(paymentId),
	)
	const [manualSignature, setManualSignature] = useState("")
	const [idemKey] = useState(() => newIdempotencyKey("solana-confirm"))
	const confirmLock = useRef(false)
	const autoStarted = useRef(false)
	const flexiConfigured = isFlexiPayWalletConfigured(import.meta.env)
	const knownSolanaSettle = isSolanaSettleRail(settleRail)

	useEffect(() => {
		const controller = new AbortController()
		getSolanaIntent(paymentId, controller.signal)
			.then((next) => {
				setNotSolanaSettle(false)
				setIntent(next)
			})
			.catch((cause) => {
				if (controller.signal.aborted) return
				if (cause instanceof ApiError && cause.status === 409) {
					// GB→abroad Solana settle waits without a claim destination today —
					// keep the panel up when detail already knows the settle rail.
					if (knownSolanaSettle) {
						setNotSolanaSettle(false)
						setError(friendlySolanaPayError(cause))
						return
					}
					setNotSolanaSettle(true)
					return
				}
				setError(friendlySolanaPayError(cause))
			})
		return () => controller.abort()
	}, [paymentId, knownSolanaSettle])

	useEffect(() => {
		setStored(loadSolanaTransfer(paymentId))
		autoStarted.current = false
	}, [paymentId])

	const markPaid = (confirmed: SolanaConfirmOk) => {
		clearSolanaTransfer(paymentId)
		setStored(null)
		setResult(confirmed)
		setVerifying(false)
		setError(null)
		onPaid?.(confirmed)
	}

	const confirmStored = async (
		memory: SolanaTransferMemory,
		opts: { announce?: boolean } = {},
	) => {
		if (confirmLock.current) return
		confirmLock.current = true
		setVerifying(true)
		setBusy(true)
		if (opts.announce !== false) {
			setError(null)
		}
		const started = Date.now()
		let delay = CONFIRM_DELAY_START_MS
		try {
			while (Date.now() - started < CONFIRM_BUDGET_MS) {
				try {
					const confirmed = await confirmSolanaTransfer(
						paymentId,
						memory.signature,
						idemKey,
					)
					markPaid(confirmed)
					return
				} catch (cause) {
					const elapsed = Date.now() - started
					if (
						shouldKeepConfirming(cause) &&
						elapsed + delay < CONFIRM_BUDGET_MS
					) {
						await sleep(delay)
						delay = Math.min(CONFIRM_DELAY_MAX_MS, Math.round(delay * 1.5))
						continue
					}
					throw cause
				}
			}
			throw new Error(
				"Transfer was submitted but not yet verified. Do not send again — use Verify transfer.",
			)
		} catch (cause) {
			setError(friendlySolanaPayError(cause))
		} finally {
			setVerifying(false)
			setBusy(false)
			confirmLock.current = false
		}
	}

	useEffect(() => {
		if (!stored || result || autoStarted.current) return
		autoStarted.current = true
		void confirmStored(stored, { announce: false })
		// eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-shot
	}, [stored, result])

	if (notSolanaSettle) return null

	const fallbackAsset = settleAmount
		? assetFromCurrency(settleAmount.currency)
		: null
	const settlement = intent
		? {
				asset: intent.asset,
				mint: intent.mint,
				decimals: intent.decimals,
			}
		: fallbackAsset
			? {
					asset: fallbackAsset,
					mint: "",
					decimals: DOMAIN_ASSET_DECIMALS,
				}
			: null
	const label = settlement ? assetLabel(settlement.asset) : "Solana"
	const displayAmount =
		intent && settlement
			? formatAssetAmount(settlement.asset, intent.amount, settlement.decimals)
			: settleAmount && fallbackAsset
				? formatAssetAmount(
						fallbackAsset,
						settleAmount.amount,
						DOMAIN_ASSET_DECIMALS,
					)
				: null
	const instructionAmount =
		intent && settlement
			? formatAssetAmount(settlement.asset, intent.amount, settlement.decimals)
			: displayAmount

	const afterSigned = async (signature: string) => {
		const memory: SolanaTransferMemory = {
			signature,
			sentAt: new Date().toISOString(),
		}
		saveSolanaTransfer(paymentId, memory)
		autoStarted.current = true
		setStored(memory)
		await confirmStored(memory)
	}

	const prepareTransfer = async (payer: string) => {
		if (!intent || !settlement) {
			throw new Error("Solana intent is not ready.")
		}
		const config = await getSolanaConfig()
		const connection = new Connection(
			config.publicRpcUrl ?? "https://api.devnet.solana.com",
			"confirmed",
		)
		const balances = await getSolAndUsdcBalances(
			connection,
			payer,
			settlement.mint,
		)
		if (balances.solLamports < MIN_SOL_LAMPORTS_FOR_FEES) {
			throw new Error("no devnet SOL for network fees")
		}
		const needed = BigInt(intent.amount)
		if (balances.usdcMinor < needed) {
			throw new Error(`insufficient ${settlement.asset}`)
		}
		return buildUsdcTransferTransaction({
			connection,
			payer,
			recipientOwner: intent.recipient,
			mint: settlement.mint,
			amountMinor: needed,
			decimals: settlement.decimals,
			reference: intent.reference,
		})
	}

	const payWithPhantom = async () => {
		if (!intent || !connected || !settlement || stored) return
		setBusy(true)
		setError(null)
		try {
			const config = await getSolanaConfig()
			const cluster = config.cluster
			if (!walletSupportsCluster(connected.wallet, cluster)) {
				throw new Error(SOLANA_PAY_ERROR_COPY.WRONG_CLUSTER)
			}
			if (!accountSupportsCluster(connected.account, cluster)) {
				throw new Error(SOLANA_PAY_ERROR_COPY.WRONG_CLUSTER)
			}
			const built = await prepareTransfer(connected.address)
			const connection = new Connection(
				config.publicRpcUrl ?? "https://api.devnet.solana.com",
				"confirmed",
			)
			const signature = await signAndSendSolanaTransaction({
				connected,
				transaction: built.transaction,
				connection,
				cluster,
			})
			await afterSigned(signature)
		} catch (cause) {
			setError(friendlySolanaPayError(cause))
			setBusy(false)
		}
	}

	const payWithFlexiPay = async (wallet: FlexiPaySolanaWallet) => {
		if (!intent || !settlement || stored) return
		setBusy(true)
		setError(null)
		try {
			const built = await prepareTransfer(wallet.address)
			const signature = await sendFlexiPaySolanaTransaction(
				wallet,
				built.transaction,
			)
			await afterSigned(signature)
		} catch (cause) {
			setError(friendlySolanaPayError(cause))
			setBusy(false)
		}
	}

	const verifyManual = async () => {
		const signature = manualSignature.trim()
		if (!signature) {
			setError("Enter a Solana transaction signature.")
			return
		}
		await afterSigned(signature)
	}

	const sentClock = stored ? formatLocalClock(stored.sentAt) : null
	const phantomDisabled = Boolean(busy || !intent || !connected || stored)
	const flexiDisabled = Boolean(busy || !intent || stored)

	return (
		<div
			className="solana-panel solana-panel--pay"
			data-testid="solana-pay-panel"
		>
			<Panel
				title={`Pay with Solana ${label} (devnet)`}
				actions={
					settlement?.asset === "TGBP" ? (
						<span className="pill pill--ok" data-testid="solana-pay-asset">
							£ (tGBP)
						</span>
					) : (
						<span className="pill" data-testid="solana-pay-asset">
							USDC
						</span>
					)
				}
			>
				{error ? (
					<Notice tone="warning" data-testid="solana-pay-error">
						{error}
					</Notice>
				) : null}
				{stored && !result ? (
					<Notice data-testid="solana-transfer-pending">
						Transfer sent at {sentClock} — verifying. Do not send again.
					</Notice>
				) : null}
				{settlement?.asset === "TGBP" && instructionAmount ? (
					<p
						className="solana-pay-instruction"
						data-testid="solana-pay-instruction"
					>
						Pay {instructionAmount} tGBP from your wallet to send this payment
					</p>
				) : null}
				{intent && settlement ? (
					<>
						<Notice>
							{intent.label}. Amount is verified on-chain before PAID. Devnet{" "}
							{label} only — not mainnet.
						</Notice>
						<div className="solana-intent-grid">
							<StaticField
								label={recipientFieldLabel}
								value={
									<span data-testid="solana-pay-recipient">
										{intent.recipient}
									</span>
								}
							/>
							<StaticField
								label={`Amount (${label})`}
								value={
									<span data-testid="solana-pay-amount">{displayAmount}</span>
								}
							/>
							<StaticField label="Asset" value={label} />
							<StaticField label="Mint" value={settlement.mint || "—"} />
						</div>
					</>
				) : settleAmount && displayAmount ? (
					<div className="solana-intent-grid">
						<StaticField
							label={`Amount (${label})`}
							value={
								<span data-testid="solana-pay-amount">{displayAmount}</span>
							}
						/>
						<StaticField label="Asset" value={label} />
					</div>
				) : (
					<p className="form-note">Loading Solana transfer intent…</p>
				)}
				<SolanaWalletPanel
					onConnected={setConnected}
					title="Sender wallet (Phantom / Wallet Standard)"
					settlement={
						intent && settlement?.mint
							? {
									asset: settlement.asset,
									mint: settlement.mint,
									decimals: settlement.decimals,
								}
							: undefined
					}
				/>
				{result ? (
					<SolanaTxSuccess
						signature={result.signature}
						explorerUrl={result.explorerUrl}
					/>
				) : (
					<>
						<div className="form-actions">
							<Button
								type="button"
								disabled={phantomDisabled}
								onClick={() => void payWithPhantom()}
								data-testid="solana-pay-send"
							>
								{busy && !stored && connected
									? "Signing / confirming…"
									: `Sign and send ${label}`}
							</Button>
							{flexiConfigured ? (
								<Suspense fallback={null}>
									<FlexiPayPayProviders>
										<FlexiPayWalletPayButton
											disabled={flexiDisabled}
											busy={busy}
											label="Pay with FlexiPay wallet"
											onPay={(wallet) => void payWithFlexiPay(wallet)}
										/>
									</FlexiPayPayProviders>
								</Suspense>
							) : null}
							{stored ? (
								<Button
									type="button"
									variant="secondary"
									disabled={busy}
									onClick={() => void confirmStored(stored)}
									data-testid="solana-verify-transfer"
								>
									{verifying ? "Verifying…" : "Verify transfer"}
								</Button>
							) : null}
						</div>
						<details
							className="solana-already-paid"
							data-testid="solana-already-paid"
						>
							<summary>I already paid</summary>
							<p className="form-note">
								Paste the Solana transaction signature if you sent from another
								wallet or the page lost the transfer.
							</p>
							<div className="field">
								<label className="field__label" htmlFor="solana-manual-sig">
									Transaction signature
								</label>
								<input
									id="solana-manual-sig"
									className="field__control"
									value={manualSignature}
									onChange={(event) => setManualSignature(event.target.value)}
									autoComplete="off"
									spellCheck={false}
									data-testid="solana-manual-signature"
								/>
							</div>
							<div className="form-actions">
								<Button
									type="button"
									variant="secondary"
									disabled={busy || !manualSignature.trim()}
									onClick={() => void verifyManual()}
									data-testid="solana-manual-verify"
								>
									Verify signature
								</Button>
							</div>
						</details>
					</>
				)}
			</Panel>
		</div>
	)
}
