import { buildUsdcTransferTransaction } from "@flexipay/adapter-solana"
import { useEffect, useState } from "react"
import { ApiError, describeApiError, newIdempotencyKey } from "../../api/client"
import {
	confirmSolanaTransfer,
	getSolanaConfig,
	getSolanaIntent,
	type SolanaConfirmOk,
	type SolanaIntent,
} from "../../api/solanaClient"
import {
	Connection,
	signAndSendSolanaTransaction,
	type ConnectedSolanaWallet,
} from "../../solana/walletStandard"
import { Button, Notice, Panel, StaticField } from "../ui"
import { SolanaWalletPanel } from "./SolanaWalletPanel"

type Props = {
	paymentId: string
	onPaid?: (result: SolanaConfirmOk) => void
}

export function SolanaPayPanel({ paymentId, onPaid }: Props) {
	const [intent, setIntent] = useState<SolanaIntent | null>(null)
	const [connected, setConnected] = useState<ConnectedSolanaWallet | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [result, setResult] = useState<SolanaConfirmOk | null>(null)
	const [idemKey] = useState(() => newIdempotencyKey("solana-confirm"))

	useEffect(() => {
		const controller = new AbortController()
		getSolanaIntent(paymentId, controller.signal)
			.then(setIntent)
			.catch((cause) => {
				if (!controller.signal.aborted) {
					setError(
						cause instanceof ApiError
							? describeApiError(cause)
							: cause instanceof Error
								? cause.message
								: "Solana intent unavailable",
					)
				}
			})
		return () => controller.abort()
	}, [paymentId])

	const pay = async () => {
		if (!intent || !connected) return
		setBusy(true)
		setError(null)
		try {
			const config = await getSolanaConfig()
			const connection = new Connection(
				config.publicRpcUrl ?? "https://api.devnet.solana.com",
				"confirmed",
			)
			const built = await buildUsdcTransferTransaction({
				connection,
				payer: connected.address,
				recipientOwner: intent.recipient,
				mint: intent.usdcMint,
				amountMinor: BigInt(intent.amount),
				decimals: intent.usdcDecimals,
			})
			const signature = await signAndSendSolanaTransaction({
				connected,
				transaction: built.transaction,
				connection,
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
			setError(
				cause instanceof ApiError
					? describeApiError(cause)
					: cause instanceof Error
						? cause.message
						: "Solana payment failed",
			)
		} finally {
			setBusy(false)
		}
	}

	return (
		<div data-testid="solana-pay-panel">
			<Panel title="Pay with Solana USDC (devnet)">
				{error ? (
					<Notice tone="warning" data-testid="solana-pay-error">
						{error}
					</Notice>
				) : null}
				{intent ? (
					<>
						<Notice>
							{intent.label}. Amount is verified on-chain before PAID.
						</Notice>
						<StaticField label="Recipient" value={intent.recipient} />
						<StaticField label="Amount (minor units)" value={intent.amount} />
						<StaticField label="Mint" value={intent.usdcMint} />
					</>
				) : (
					<p className="form-note">Loading Solana transfer intent…</p>
				)}
				<SolanaWalletPanel onConnected={setConnected} title="Sender wallet" />
				{result ? (
					<Notice data-testid="solana-pay-success">
						Paid (backend-verified).{" "}
						<a href={result.explorerUrl} target="_blank" rel="noreferrer">
							View on Explorer
						</a>
						<span className="form-note"> Signature: {result.signature}</span>
					</Notice>
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
