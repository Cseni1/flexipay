import { useEffect, useState } from "react"
import {
	ApiError,
	confirmBlindpayPayout,
	describeApiError,
	requestBlindpayDelegation,
} from "../../api/client"
import { getSolanaConfig } from "../../api/solanaClient"
import {
	signAndSendVersionedSolanaTransaction,
	type ClusterLabel,
	type ConnectedSolanaWallet,
} from "../../solana/walletStandard"
import { Button, Notice } from "../ui"
import { SolanaWalletPanel } from "./SolanaWalletPanel"

/**
 * CCR-45: confirm, then approve the BlindPay delegation in the sender's wallet.
 * FlexiPay never holds the stablecoins.
 */
export function BlindpaySenderPanel({
	paymentId,
	onChanged,
}: {
	paymentId: string
	onChanged: () => void
}) {
	const [connected, setConnected] = useState<ConnectedSolanaWallet | null>(null)
	const [confirmed, setConfirmed] = useState(false)
	const [cluster, setCluster] = useState<ClusterLabel>("devnet")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [tracking, setTracking] = useState(false)

	useEffect(() => {
		const controller = new AbortController()
		getSolanaConfig(controller.signal)
			.then((cfg) => {
				if (
					cfg.cluster === "devnet" ||
					cfg.cluster === "testnet" ||
					cfg.cluster === "mainnet-beta"
				) {
					setCluster(cfg.cluster)
				}
			})
			.catch(() => {
				/* devnet stays the default when config is unavailable */
			})
		return () => controller.abort()
	}, [])

	const liveBlocked = cluster === "mainnet-beta"

	const approve = async () => {
		if (!connected || !confirmed || liveBlocked) return
		setBusy(true)
		setError(null)
		try {
			const delegation = await requestBlindpayDelegation(
				paymentId,
				connected.address,
			)
			let signature = await signAndSendVersionedSolanaTransaction({
				connected,
				transactionBase64: delegation.transaction,
				cluster,
			})
			let result = await confirmBlindpayPayout(paymentId, signature)
			if (result.status === "requote") {
				signature = await signAndSendVersionedSolanaTransaction({
					connected,
					transactionBase64: result.transaction,
					cluster,
				})
				result = await confirmBlindpayPayout(paymentId, signature)
			}
			if (result.status !== "accepted") {
				throw new Error("BlindPay did not accept the payout")
			}
			setTracking(true)
			onChanged()
		} catch (cause) {
			setError(
				cause instanceof ApiError
					? describeApiError(cause)
					: cause instanceof Error
						? cause.message
						: "The wallet approval failed",
			)
		} finally {
			setBusy(false)
		}
	}

	return (
		<div data-testid="blindpay-sender-panel">
			<SolanaWalletPanel
				title="Your Solana wallet"
				onConnected={setConnected}
			/>
			{liveBlocked ? (
				<Notice tone="warning" data-testid="blindpay-mainnet-blocked">
					Sender-wallet payouts stay on the BlindPay devnet instance in this
					build.
				</Notice>
			) : (
				<>
					<h3 className="panel__title">Confirm before signing</h3>
					<p>
						BlindPay will pull the stablecoins from your wallet and pay the
						recipient&apos;s bank. FlexiPay does not hold the funds.
					</p>
					<label>
						<input
							type="checkbox"
							checked={confirmed}
							onChange={(event) => setConfirmed(event.target.checked)}
							data-testid="blindpay-confirm"
						/>{" "}
						I confirm this payout
					</label>
					<div className="form-actions">
						<Button
							type="button"
							disabled={!connected || !confirmed || busy}
							data-testid="blindpay-approve"
							data-sign-locked={(!confirmed).toString()}
							onClick={() => void approve()}
						>
							{busy ? "Waiting for your wallet…" : "Approve in your wallet"}
						</Button>
					</div>
				</>
			)}
			{tracking ? (
				<Notice data-testid="blindpay-tracking">
					Tracking the payout. A failure returns the stablecoins to your wallet.
				</Notice>
			) : null}
			{error ? (
				<Notice tone="warning" data-testid="blindpay-approve-error">
					{error}
				</Notice>
			) : null}
		</div>
	)
}
