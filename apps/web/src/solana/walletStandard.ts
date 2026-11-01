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

/** Preferred real-user wallets (Wallet Standard names). */
export const PREFERRED_USER_WALLETS = ["Phantom", "Solflare"] as const

/** Playwright-only harness — never offer this in the human connect UI. */
export const FP_DEVNET_TEST_WALLET_NAME = "FlexiPay Devnet Test Wallet"

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

export type ClusterLabel = "devnet" | "testnet" | "mainnet-beta"

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
	opts: ListSolanaWalletsOptions = {},
): () => void {
	const api = getWallets()
	const refresh = () => listener()
	const offRegister = api.on("register", refresh)
	const offUnregister = api.on("unregister", refresh)
	void opts
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
		throw new Error(
			"No Solana wallet found. Install Phantom or Solflare (Wallet Standard) and set the extension to Devnet.",
		)
	}
	if (!opts.includeTestHarness && isTestHarnessWallet(wallet) && !walletName) {
		throw new Error(
			"Only the automated test wallet is available. Install Phantom or Solflare for a real user payment.",
		)
	}
	const standardConnect = wallet.features["standard:connect"] as
		| {
				connect: (input?: {
					silent?: boolean
				}) => Promise<{ accounts: readonly WalletAccount[] }>
		  }
		| undefined
	if (standardConnect) {
		await standardConnect.connect()
	}
	const account = wallet.accounts[0]
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

export async function signAndSendSolanaTransaction(opts: {
	connected: ConnectedSolanaWallet
	transaction: Transaction
	connection: Connection
	/** Required cluster for the transfer — do not use the wallet's mainnet default. */
	cluster: ClusterLabel
	options?: SendOptions
}): Promise<string> {
	const { connected, transaction, connection, cluster } = opts
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
		const [outcome] = await feature.signAndSendTransaction({
			account: connected.account,
			chain,
			transaction: serialized,
			options: opts.options,
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

export function shortAddress(address: string): string {
	if (address.length < 10) return address
	return `${address.slice(0, 4)}…${address.slice(-4)}`
}

export { Connection, PublicKey, Transaction }
