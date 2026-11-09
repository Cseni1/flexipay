import {
	buildUsdcTransferTransaction,
	getSolAndUsdcBalances,
} from "@flexipay/adapter-solana/browser"
import { type DueFundingResponse } from "@flexipay/web-lib/contract"
import { useEffect, useRef, useState } from "react"
import {
	ApiError,
	confirmDueFunding,
	describeApiError,
	getDueFunding,
	prepareDueFunding,
} from "../../api/client"
import { getSolanaConfig } from "../../api/solanaClient"
import { formatLocalClock } from "../../payments/formatPaymentTime"
import {
	clearSolanaTransfer,
	loadSolanaTransfer,
	saveSolanaTransfer,
} from "../../payments/solanaTransferStorage"
import { formatAssetAmount } from "../../solana/assets"
import {
	Connection,
	shortAddress,
	signAndSendSolanaTransaction,
	type ClusterLabel,
	type ConnectedSolanaWallet,
} from "../../solana/walletStandard"
import { Button, Notice } from "../ui"
import { SolanaWalletPanel } from "./SolanaWalletPanel"

const MIN_SOL_LAMPORTS_FOR_FEES = 5_000n
const CONFIRM_BUDGET_MS = 90_000
const CONFIRM_DELAY_START_MS = 1_500
const CONFIRM_DELAY_MAX_MS = 6_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Network name in plain words. */
export function networkLabel(cluster: string): string {
	if (cluster === "mainnet-beta") return "Solana"
	return `Solana (${cluster}, test network)`
}

/** The facts the sender needs before approving, in plain words. */
export function dueFundingFacts(
	funding: DueFundingResponse,
): { label: string; value: string }[] {
	return [
		{
			label: "Amount",
			value: `${formatAssetAmount("USDC", funding.amount, funding.decimals)} USDC`,
		},
		{ label: "Network", value: networkLabel(funding.cluster) },
		{ label: "From your wallet", value: shortAddress(funding.senderWallet) },
		{ label: "To Due", value: shortAddress(funding.recipient) },
		...(funding.expiresAt
			? [{ label: "Send before", value: formatLocalClock(funding.expiresAt) }]
			: []),
	]
}

/**
 * CCR-51: the sender pays a Due payout from their own Solana wallet. FlexiPay asks Due to set up
 * the transfer for this wallet, the wallet sends the exact USDC straight to Due, and FlexiPay
 * checks the transfer on Solana. FlexiPay never holds the money.
 */
export function DueSenderPanel({
	paymentId,
	onChanged,
}: {
	paymentId: string
	onChanged: () => void
}) {
	const [connected, setConnected] = useState<ConnectedSolanaWallet | null>(null)
	const [funding, setFunding] = useState<DueFundingResponse | null>(null)
	const [confirmed, setConfirmed] = useState(false)
	const [busy, setBusy] = useState(false)
	const [stage, setStage] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [sentSignature, setSentSignature] = useState<string | null>(null)
	const lock = useRef(false)

	useEffect(() => {
		const controller = new AbortController()
		getDueFunding(paymentId, controller.signal)
			.then((next) => setFunding(next))
			.catch(() => {
				/* not set up yet (409) or offline: the button sets it up */
			})
		setSentSignature(loadSolanaTransfer(paymentId)?.signature ?? null)
		return () => controller.abort()
	}, [paymentId])

	const confirmLoop = async (signature: string) => {
		setStage("Waiting for Solana to confirm your transfer…")
		const started = Date.now()
		let delay = CONFIRM_DELAY_START_MS
		while (Date.now() - started < CONFIRM_BUDGET_MS) {
			const result = await confirmDueFunding(paymentId, signature)
			if (result.status === "verified") {
				clearSolanaTransfer(paymentId)
				setSentSignature(null)
				setFunding((current) =>
					current ? { ...current, state: "funded", signature } : current,
				)
				onChanged()
				return
			}
			await sleep(delay)
			delay = Math.min(CONFIRM_DELAY_MAX_MS, Math.round(delay * 1.5))
		}
		throw new Error(
			"Your transfer was sent but Solana has not confirmed it yet. Do not send again. Use Check again in a minute.",
		)
	}

	const run = async (work: () => Promise<void>) => {
		if (lock.current) return
		lock.current = true
		setBusy(true)
		setError(null)
		try {
			await work()
		} catch (cause) {
			setError(
				cause instanceof ApiError
					? describeApiError(cause)
					: cause instanceof Error
						? cause.message
						: "The wallet approval failed",
			)
		} finally {
			lock.current = false
			setBusy(false)
			setStage(null)
		}
	}

	const approve = () =>
		run(async () => {
			if (!connected || !confirmed) return
			let ready = funding
			if (!ready) {
				setStage("Setting up the transfer with Due…")
				ready = await prepareDueFunding(paymentId, connected.address)
				setFunding(ready)
			}
			if (ready.state !== "awaiting_transfer") return
			if (ready.senderWallet !== connected.address) {
				throw new Error(
					`Due set this payment up for wallet ${shortAddress(ready.senderWallet)}. Connect that wallet to pay; Due does not accept USDC from another wallet.`,
				)
			}
			const config = await getSolanaConfig()
			const connection = new Connection(
				config.publicRpcUrl ?? "https://api.devnet.solana.com",
				"confirmed",
			)
			const amount = BigInt(ready.amount)
			const balances = await getSolAndUsdcBalances(
				connection,
				connected.address,
				ready.mint,
			)
			if (balances.solLamports < MIN_SOL_LAMPORTS_FOR_FEES) {
				throw new Error(
					"Your wallet needs a little SOL to pay the network fee.",
				)
			}
			if (balances.usdcMinor < amount) {
				throw new Error(
					`Your wallet holds less than ${formatAssetAmount("USDC", ready.amount, ready.decimals)} USDC.`,
				)
			}
			const built = await buildUsdcTransferTransaction({
				connection,
				payer: connected.address,
				recipientOwner: ready.recipient,
				mint: ready.mint,
				amountMinor: amount,
				decimals: ready.decimals,
				reference: ready.reference,
			})
			setStage("Approve the transfer in your wallet…")
			const signature = await signAndSendSolanaTransaction({
				connected,
				transaction: built.transaction,
				connection,
				cluster: ready.cluster as ClusterLabel,
			})
			saveSolanaTransfer(paymentId, {
				signature,
				sentAt: new Date().toISOString(),
			})
			setSentSignature(signature)
			await confirmLoop(signature)
		})

	const checkAgain = () =>
		run(async () => {
			if (sentSignature) await confirmLoop(sentSignature)
		})

	const state = funding?.state ?? null

	return (
		<div data-testid="due-sender-panel">
			{state === "funded" ? (
				<Notice data-testid="due-funded">
					Due has your USDC. Due now changes it and pays the bank. This page
					updates by itself.
				</Notice>
			) : state === "expired" ? (
				<Notice tone="warning" data-testid="due-expired">
					Due's 2-hour window to receive the USDC closed. Due does not accept a
					late transfer, so this payment has stopped. If you did send USDC,
					contact support with the transaction.
				</Notice>
			) : (
				<>
					<p>
						You send USDC from your own Solana wallet straight to Due. Due
						changes it and pays the recipient's bank. FlexiPay never holds the
						money.
					</p>
					<SolanaWalletPanel
						title="Your Solana wallet"
						onConnected={setConnected}
					/>
					{funding ? (
						<dl className="detail-facts" data-testid="due-funding-facts">
							{dueFundingFacts(funding).map((fact) => (
								<div key={fact.label}>
									<dt>{fact.label}</dt>
									<dd>{fact.value}</dd>
								</div>
							))}
						</dl>
					) : (
						<p className="form-note">
							Due sets the exact amount when you connect your wallet and
							continue.
						</p>
					)}
					<Notice>
						Send the exact amount, in one go, from this wallet, before the time
						shown. Due does not accept a different amount, another wallet or a
						late transfer.
					</Notice>
					<label>
						<input
							type="checkbox"
							checked={confirmed}
							onChange={(event) => setConfirmed(event.target.checked)}
							data-testid="due-confirm"
						/>{" "}
						I confirm this payment
					</label>
					<div className="form-actions">
						<Button
							type="button"
							disabled={!connected || !confirmed || busy || !!sentSignature}
							data-testid="due-approve"
							onClick={() => void approve()}
						>
							{busy
								? (stage ?? "Waiting for your wallet…")
								: "Approve in your wallet"}
						</Button>
						{sentSignature && !busy ? (
							<Button
								type="button"
								variant="secondary"
								data-testid="due-check-again"
								onClick={() => void checkAgain()}
							>
								Check again
							</Button>
						) : null}
					</div>
					{sentSignature ? (
						<Notice data-testid="due-sent">
							Transfer sent. Do not send it again; we are checking it on Solana.
						</Notice>
					) : null}
				</>
			)}
			{error ? (
				<Notice tone="warning" data-testid="due-approve-error">
					{error}
				</Notice>
			) : null}
		</div>
	)
}
