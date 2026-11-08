import {
	SolanaSignAndSendTransaction,
	SolanaSignTransaction,
	type SolanaSignAndSendTransactionFeature,
	type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features"
import {
	Connection,
	PublicKey,
	Transaction,
	VersionedTransaction,
	type SendOptions,
} from "@solana/web3.js"
import { getWallets } from "@wallet-standard/app"
import { type Wallet, type WalletAccount } from "@wallet-standard/base"
import bs58 from "bs58"

const SOLANA_CHAINS = [
	"solana:devnet",
	"solana:testnet",
	"solana:mainnet",
] as const

export type SolanaChainId = (typeof SOLANA_CHAINS)[number]

/** Preferred real-user wallets (Wallet Standard registry names). */
export const PREFERRED_USER_WALLETS = ["Phantom", "Solflare"] as const

/**
 * Playwright-only harness name (apps/web/test-harness/devnetTestWallet.ts).
 * Never offer this in the human connect UI.
 */
export const FP_DEVNET_TEST_WALLET_NAME = "FlexiPay Devnet Test Wallet"

/** Confirmed FlexiPay Solana cluster labels (devnet-first demo). */
export type ClusterLabel = "devnet" | "testnet" | "mainnet-beta"

type SolanaFeatureWallet = Wallet & {
	features: Record<string, unknown> &
		Partial<SolanaSignAndSendTransactionFeature> &
		Partial<SolanaSignTransactionFeature>
}

export type ConnectedSolanaWallet = {
	wallet: SolanaFeatureWallet
	account: WalletAccount
	address: string
}

export type ListSolanaWalletsOptions = {
	/** Include the Playwright harness wallet. Default false for human UI. */
	includeTestHarness?: boolean
}

export const clusterToChainId = (cluster: ClusterLabel): SolanaChainId => {
	if (cluster === "mainnet-beta") return "solana:mainnet"
	if (cluster === "testnet") return "solana:testnet"
	return "solana:devnet"
}

export const isTestHarnessWallet = (wallet: Wallet): boolean =>
	wallet.name === FP_DEVNET_TEST_WALLET_NAME

const hasSolanaFeatures = (wallet: Wallet): wallet is SolanaFeatureWallet => {
	const chains = wallet.chains ?? []
	const hasSolana = chains.some((c) =>
		SOLANA_CHAINS.includes(c as SolanaChainId),
	)
	const features = wallet.features as Record<string, unknown>
	return (
		hasSolana &&
		(SolanaSignAndSendTransaction in features ||
			SolanaSignTransaction in features)
	)
}

const walletRank = (name: string): number => {
	const preferred = PREFERRED_USER_WALLETS.indexOf(
		name as (typeof PREFERRED_USER_WALLETS)[number],
	)
	if (preferred >= 0) return preferred
	if (name === FP_DEVNET_TEST_WALLET_NAME) return 1000
	return 100
}

export function listSolanaWallets(
	opts: ListSolanaWalletsOptions = {},
): SolanaFeatureWallet[] {
	const { get } = getWallets()
	return get()
		.filter(hasSolanaFeatures)
		.filter((wallet) =>
			opts.includeTestHarness ? true : !isTestHarnessWallet(wallet),
		)
		.slice()
		.sort((a, b) => walletRank(a.name) - walletRank(b.name))
}

/** Subscribe to Wallet Standard registry changes (extension load / unload). */
export function subscribeSolanaWallets(
	listener: () => void,
	_opts: ListSolanaWalletsOptions = {},
): () => void {
	const api = getWallets()
	const refresh = () => listener()
	const offRegister = api.on("register", refresh)
	const offUnregister = api.on("unregister", refresh)
	return () => {
		offRegister()
		offUnregister()
	}
}

export function walletSupportsCluster(
	wallet: SolanaFeatureWallet,
	cluster: ClusterLabel,
): boolean {
	const needed = clusterToChainId(cluster)
	const chains = wallet.chains ?? []
	return chains.includes(needed)
}

export function accountSupportsCluster(
	account: WalletAccount,
	cluster: ClusterLabel,
): boolean {
	const needed = clusterToChainId(cluster)
	const chains = account.chains ?? []
	// Some wallets omit per-account chains; treat empty as "follow wallet".
	if (chains.length === 0) return true
	return chains.includes(needed)
}

export async function connectSolanaWallet(
	walletName?: string,
	opts: ListSolanaWalletsOptions = {},
): Promise<ConnectedSolanaWallet> {
	const wallets = listSolanaWallets(opts)
	const wallet =
		(walletName ? wallets.find((w) => w.name === walletName) : undefined) ??
		wallets[0]
	if (!wallet) {
		if (!opts.includeTestHarness) {
			const { get } = getWallets()
			const onlyHarness = get()
				.filter(hasSolanaFeatures)
				.every(isTestHarnessWallet)
			if (
				onlyHarness &&
				get().filter(hasSolanaFeatures).some(isTestHarnessWallet)
			) {
				throw new Error(
					"Only the automated test wallet is available. Install Phantom or Solflare for a real user payment.",
				)
			}
		}
		throw new Error(
			"No Solana wallet found. Install Phantom or Solflare (Wallet Standard) and set the extension to Devnet.",
		)
	}
	const standardConnect = wallet.features["standard:connect"] as
		| {
				connect: (input?: {
					silent?: boolean
				}) => Promise<{ accounts: readonly WalletAccount[] }>
		  }
		| undefined
	let account = wallet.accounts[0]
	if (standardConnect) {
		const result = await standardConnect.connect()
		account = result.accounts[0] ?? wallet.accounts[0]
	}
	if (!account) {
		throw new Error("Wallet connected but returned no account")
	}
	return {
		wallet,
		account,
		address: account.address,
	}
}

export async function disconnectSolanaWallet(
	wallet: SolanaFeatureWallet,
): Promise<void> {
	const standardDisconnect = wallet.features["standard:disconnect"] as
		{ disconnect: () => Promise<void> } | undefined
	if (standardDisconnect) await standardDisconnect.disconnect()
}

/**
 * Listen for account / chain changes on a connected wallet.
 * Returns an unsubscribe function.
 */
export function subscribeWalletAccountChanges(
	wallet: SolanaFeatureWallet,
	onChange: (accounts: readonly WalletAccount[]) => void,
): () => void {
	const events = wallet.features["standard:events"] as
		| {
				on: (
					event: string,
					listener: (...args: unknown[]) => void,
				) => () => void
		  }
		| undefined
	if (!events?.on) return () => undefined
	return events.on("change", (...args: unknown[]) => {
		const payload = args[0] as
			{ accounts?: readonly WalletAccount[] } | undefined
		if (payload?.accounts) {
			onChange(payload.accounts)
			return
		}
		onChange(wallet.accounts)
	})
}

/**
 * Map wallet / user-facing errors to safe copy (no secrets).
 * Used by wallet UI; payment panels may keep their own messaging.
 */
export function describeWalletUserError(cause: unknown): string {
	const raw =
		cause instanceof Error
			? cause.message
			: typeof cause === "string"
				? cause
				: "Wallet action failed"
	const lower = raw.toLowerCase()
	if (
		lower.includes("reject") ||
		lower.includes("denied") ||
		lower.includes("user cancel") ||
		lower.includes("cancelled") ||
		lower.includes("canceled")
	) {
		return "Wallet rejected the request. Nothing was sent — you can try again."
	}
	if (lower.includes("devnet") || lower.includes("network")) {
		return raw
	}
	if (lower.includes("no solana wallet") || lower.includes("install phantom")) {
		return raw
	}
	return raw
}

export async function signAndSendSolanaTransaction(opts: {
	connected: ConnectedSolanaWallet
	transaction: Transaction
	connection: Connection
	/**
	 * Required cluster for the transfer. Defaults to `devnet` so existing
	 * Solana pay callers stay compatible without page changes (TASK 04).
	 */
	cluster?: ClusterLabel
	options?: SendOptions
}): Promise<string> {
	const { connected, transaction, connection } = opts
	const cluster: ClusterLabel = opts.cluster ?? "devnet"
	const chain = clusterToChainId(cluster)

	if (!walletSupportsCluster(connected.wallet, cluster)) {
		throw new Error(
			`Wallet does not advertise ${chain}. Open Phantom/Solflare settings and switch the active network to Devnet.`,
		)
	}
	if (!accountSupportsCluster(connected.account, cluster)) {
		throw new Error(
			`Connected account is not enabled for ${chain}. Switch the wallet network to Devnet and reconnect.`,
		)
	}

	const feature = connected.wallet.features[SolanaSignAndSendTransaction] as
		| SolanaSignAndSendTransactionFeature[typeof SolanaSignAndSendTransaction]
		| undefined
	if (feature) {
		const serialized = transaction.serialize({
			requireAllSignatures: false,
			verifySignatures: false,
		})
		// Wallet Standard rejects Solana web3.js Commitment values like "max"/"recent".
		const walletOptions = (() => {
			if (!opts.options) return undefined
			const { preflightCommitment, ...rest } = opts.options
			if (
				preflightCommitment === undefined ||
				preflightCommitment === "processed" ||
				preflightCommitment === "confirmed" ||
				preflightCommitment === "finalized"
			) {
				return { ...rest, preflightCommitment }
			}
			return { ...rest, preflightCommitment: "confirmed" as const }
		})()
		const [outcome] = await feature.signAndSendTransaction({
			account: connected.account,
			chain,
			transaction: serialized,
			options: walletOptions,
		})
		if (!outcome?.signature) {
			throw new Error("Wallet did not return a transaction signature")
		}
		return bs58.encode(outcome.signature)
	}

	const signFeature = connected.wallet.features[SolanaSignTransaction] as
		SolanaSignTransactionFeature[typeof SolanaSignTransaction] | undefined
	if (!signFeature) {
		throw new Error("Wallet cannot sign Solana transactions")
	}
	const [signed] = await signFeature.signTransaction({
		account: connected.account,
		chain,
		transaction: transaction.serialize({
			requireAllSignatures: false,
			verifySignatures: false,
		}),
	})
	if (!signed?.signedTransaction) {
		throw new Error("Wallet did not return a signed transaction")
	}
	const wire = Transaction.from(signed.signedTransaction)
	const signature = await connection.sendRawTransaction(wire.serialize(), {
		skipPreflight: false,
		preflightCommitment: "confirmed",
		...opts.options,
	})
	return signature
}

function bytesFromBase64(value: string): Uint8Array {
	const binary = atob(value)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	return bytes
}

/**
 * CCR-45: sign BlindPay's base64 VersionedTransaction with the connected wallet
 * and return the signature. Devnet only; this build does not sign on mainnet.
 */
export async function signAndSendVersionedSolanaTransaction(opts: {
	connected: ConnectedSolanaWallet
	transactionBase64: string
	cluster?: ClusterLabel
	/**
	 * CCR-49: mainnet signing only when the API itself runs on mainnet (it refuses to start
	 * there without FP_LIVE_MONEY=1 and the individual limits, CCR-44).
	 */
	allowMainnet?: boolean
}): Promise<string> {
	const cluster: ClusterLabel = opts.cluster ?? "devnet"
	if (cluster === "mainnet-beta" && !opts.allowMainnet) {
		throw new Error(
			"Sender-wallet BlindPay signing stays on devnet in this build.",
		)
	}
	const chain = clusterToChainId(cluster)
	const bytes = bytesFromBase64(opts.transactionBase64)
	VersionedTransaction.deserialize(bytes)
	if (!walletSupportsCluster(opts.connected.wallet, cluster)) {
		throw new Error(
			`Wallet does not advertise ${chain}. Switch the wallet to ${cluster === "mainnet-beta" ? "Mainnet" : "Devnet"} and reconnect.`,
		)
	}
	const feature = opts.connected.wallet.features[
		SolanaSignAndSendTransaction
	] as
		| SolanaSignAndSendTransactionFeature[typeof SolanaSignAndSendTransaction]
		| undefined
	if (!feature) throw new Error("Wallet cannot sign Solana transactions")
	const [outcome] = await feature.signAndSendTransaction({
		account: opts.connected.account,
		chain,
		transaction: bytes,
	})
	if (!outcome?.signature) {
		throw new Error("Wallet did not return a transaction signature")
	}
	return bs58.encode(outcome.signature)
}

export function shortAddress(address: string): string {
	if (address.length < 10) return address
	return `${address.slice(0, 4)}…${address.slice(-4)}`
}

export { Connection, PublicKey, Transaction }
