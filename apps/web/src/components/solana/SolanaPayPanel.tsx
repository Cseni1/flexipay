import {
	buildUsdcTransferTransaction,
	getSolAndUsdcBalances,
} from "@flexipay/adapter-solana/browser"
import { useEffect, useState } from "react"
import { ApiError, newIdempotencyKey } from "../../api/client"
import {
	confirmSolanaTransfer,
	getSolanaConfig,
	getSolanaIntent,
	type SolanaConfirmOk,
	type SolanaIntent,
} from "../../api/solanaClient"
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
import { SolanaTxSuccess } from "./SolanaTxSuccess"
import { SolanaWalletPanel } from "./SolanaWalletPanel"

type Props = {
	paymentId: string
	onPaid?: (result: SolanaConfirmOk) => void
}

/** Rough lower bound so the wallet can pay a simple SPL transfer fee on devnet. */
const MIN_SOL_LAMPORTS_FOR_FEES = 5_000n

export function SolanaPayPanel({ paymentId, onPaid }: Props) {
	const [intent, setIntent] = useState<SolanaIntent | null>(null)
	const [notSolanaSettle, setNotSolanaSettle] = useState(false)
	const [connected, setConnected] = useState<ConnectedSolanaWallet | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [result, setResult] = useState<SolanaConfirmOk | null>(null)
	const [idemKey] = useState(() => newIdempotencyKey("solana-confirm"))

	useEffect(() => {
		const controller = new AbortController()
		getSolanaIntent(paymentId, controller.signal)
			.then((next) => {
				setNotSolanaSettle(false)
				setIntent(next)
			})
			.catch((cause) => {
				if (controller.signal.aborted) return
				// 409 = claim not accepted to Solana / settle not waiting — hide panel.
				if (cause instanceof ApiError && cause.status === 409) {
					setNotSolanaSettle(true)
					return
				}
				setError(friendlySolanaPayError(cause))
			})
		return () => controller.abort()
	}, [paymentId])

	if (notSolanaSettle) return null

	const pay = async () => {
		if (!intent || !connected) return
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

			const connection = new Connection(
				config.publicRpcUrl ?? "https://api.devnet.solana.com",
				"confirmed",
			)

			const balances = await getSolAndUsdcBalances(
				connection,
				connected.address,
				intent.usdcMint,
			)
			if (balances.solLamports < MIN_SOL_LAMPORTS_FOR_FEES) {
				throw new Error("no devnet SOL for network fees")
			}
			const needed = BigInt(intent.amount)
			if (balances.usdcMinor < needed) {
				throw new Error("insufficient USDC")
			}

			const built = await buildUsdcTransferTransaction({
				connection,
				payer: connected.address,
				recipientOwner: intent.recipient,
				mint: intent.usdcMint,
				amountMinor: needed,
				decimals: intent.usdcDecimals,
				reference: intent.reference,
			})
			const signature = await signAndSendSolanaTransaction({
				connected,
				transaction: built.transaction,
				connection,
				cluster,
			})
			let confirmed: SolanaConfirmOk | null = null
			for (let attempt = 0; attempt < 8; attempt += 1) {
				try {
					confirmed = await confirmSolanaTransfer(paymentId, signature, idemKey)
					break
				} catch (cause) {
					if (
						cause instanceof ApiError &&
						(cause.status === 202 || cause.code === "pending")
					) {
						await new Promise((r) => setTimeout(r, 1500))
						continue
					}
					throw cause
				}
			}
			if (!confirmed) {
				throw new Error(
					"Transfer was submitted but not yet verified. Do not send again — retry confirm later.",
				)
			}
			setResult(confirmed)
			onPaid?.(confirmed)
		} catch (cause) {
			setError(friendlySolanaPayError(cause))
		} finally {
			setBusy(false)
		}
	}

	return (
		<div
			className="solana-panel solana-panel--pay"
			data-testid="solana-pay-panel"
		>
			<Panel title="Pay with Solana USDC (devnet)">
				{error ? (
					<Notice tone="warning" data-testid="solana-pay-error">
						{error}
					</Notice>
				) : null}
				{intent ? (
					<>
						<Notice>
							{intent.label}. Amount is verified on-chain before PAID. Devnet
							USDC only — not mainnet.
						</Notice>
						<div className="solana-intent-grid">
							<StaticField label="Recipient" value={intent.recipient} />
							<StaticField label="Amount (minor units)" value={intent.amount} />
							<StaticField label="Mint" value={intent.usdcMint} />
						</div>
					</>
				) : (
					<p className="form-note">Loading Solana transfer intent…</p>
				)}
				<SolanaWalletPanel onConnected={setConnected} title="Sender wallet" />
				{result ? (
					<SolanaTxSuccess
						signature={result.signature}
						explorerUrl={result.explorerUrl}
					/>
				) : (
					<Button
						type="button"
						disabled={busy || !intent || !connected}
						onClick={() => void pay()}
						data-testid="solana-pay-send"
					>
						{busy ? "Signing / confirming…" : "Sign and send USDC"}
					</Button>
				)}
			</Panel>
		</div>
	)
}
