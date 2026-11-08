import { useEffect, useState } from "react"
import {
	ApiError,
	confirmBlindpayPayout,
	confirmSolanaSwap,
	describeApiError,
	requestBlindpayDelegation,
	requestSolanaSwap,
} from "../../api/client"
import { getSolanaConfig } from "../../api/solanaClient"
import {
	formatUnits,
	waitForSwap,
	type SwapPreview,
} from "../../payments/solanaSwap"
import {
	signAndSendVersionedSolanaTransaction,
	type ClusterLabel,
	type ConnectedSolanaWallet,
} from "../../solana/walletStandard"
import { Button, Notice } from "../ui"
import { SolanaWalletPanel } from "./SolanaWalletPanel"

/**
 * CCR-45: confirm, then approve the BlindPay delegation in the sender's wallet.
 * CCR-49: a sender paying with tGBP first swaps it to USDC in the same wallet (Jupiter).
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
	const [swapAssets, setSwapAssets] = useState<"TGBP"[]>([])
	const [payWith, setPayWith] = useState<"USDC" | "TGBP">("USDC")
	const [preview, setPreview] = useState<SwapPreview | null>(null)
	const [stage, setStage] = useState<string | null>(null)

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
				setSwapAssets(cfg.swapInputAssets ?? [])
			})
			.catch(() => {
				/* devnet stays the default when config is unavailable */
			})
		return () => controller.abort()
	}, [])

	// The API runs on mainnet only with FP_LIVE_MONEY=1 and the individual limits (CCR-44).
	const allowMainnet = cluster === "mainnet-beta"
	const swapping = payWith === "TGBP"

	useEffect(() => {
		setPreview(null)
		if (!swapping || !connected) return
		const controller = new AbortController()
		requestSolanaSwap(paymentId, connected.address, controller.signal)
			.then((swap) => setPreview(swap))
			.catch((cause) => {
				if (controller.signal.aborted) return
				setError(
					cause instanceof ApiError
						? describeApiError(cause)
						: "Could not price the tGBP swap",
				)
			})
		return () => controller.abort()
	}, [swapping, connected, paymentId])

	const approve = async () => {
		if (!connected || !confirmed) return
		setBusy(true)
		setError(null)
		try {
			if (swapping) {
				setStage("Pricing the tGBP swap…")
				const swap = await requestSolanaSwap(paymentId, connected.address)
				setPreview(swap)
				if (swap.status === "ready") {
					setStage("Approve the swap in your wallet…")
					const swapSignature = await signAndSendVersionedSolanaTransaction({
						connected,
						transactionBase64: swap.transaction,
						cluster,
						allowMainnet,
					})
					setStage("Waiting for the swap to land on Solana…")
					await waitForSwap(() =>
						confirmSolanaSwap(paymentId, connected.address, swapSignature),
					)
				}
			}
			setStage("Approve the payout in your wallet…")
			const delegation = await requestBlindpayDelegation(
				paymentId,
				connected.address,
			)
			let signature = await signAndSendVersionedSolanaTransaction({
				connected,
				transactionBase64: delegation.transaction,
				cluster,
				allowMainnet,
			})
			let result = await confirmBlindpayPayout(paymentId, signature)
			if (result.status === "requote") {
				signature = await signAndSendVersionedSolanaTransaction({
					connected,
					transactionBase64: result.transaction,
					cluster,
					allowMainnet,
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
			setStage(null)
		}
	}

	return (
		<div data-testid="blindpay-sender-panel">
			<SolanaWalletPanel
				title="Your Solana wallet"
				onConnected={setConnected}
			/>
			{swapAssets.includes("TGBP") ? (
				<fieldset className="pay-with" data-testid="blindpay-pay-with">
					<legend>Pay with</legend>
					<label>
						<input
							type="radio"
							name="blindpay-pay-with"
							checked={payWith === "USDC"}
							onChange={() => setPayWith("USDC")}
							data-testid="blindpay-pay-usdc"
						/>{" "}
						USDC
					</label>{" "}
					<label>
						<input
							type="radio"
							name="blindpay-pay-with"
							checked={payWith === "TGBP"}
							onChange={() => setPayWith("TGBP")}
							data-testid="blindpay-pay-tgbp"
						/>{" "}
						tGBP (pounds)
					</label>
				</fieldset>
			) : null}
			{swapping && preview ? (
				<Notice data-testid="blindpay-swap-preview">
					{preview.status === "not_needed"
						? "Your wallet already holds enough USDC; no swap needed."
						: `Swap about ${formatUnits(preview.inputAmount, preview.inputDecimals)} tGBP (at most ${formatUnits(preview.inputMaxAmount, preview.inputDecimals)}) for ${formatUnits(preview.outputAmount, preview.outputDecimals)} USDC in your wallet via Jupiter, then pay out.`}
				</Notice>
			) : null}
			<h3 className="panel__title">Confirm before signing</h3>
			<p>
				{swapping
					? "Your wallet first swaps tGBP to USDC (Jupiter), then BlindPay pulls the USDC and pays the recipient's bank. You approve both in your wallet. FlexiPay does not hold the funds."
					: "BlindPay will pull the stablecoins from your wallet and pay the recipient's bank. FlexiPay does not hold the funds."}
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
					{busy
						? (stage ?? "Waiting for your wallet…")
						: "Approve in your wallet"}
				</Button>
			</div>
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
