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

export function listSolanaWallets(): SolanaFeatureWallet[] {
	const { get } = getWallets()
	return get().filter((wallet): wallet is SolanaFeatureWallet => {
		const chains = wallet.chains ?? []
		const hasSolana = chains.some((c) =>
			SOLANA_CHAINS.includes(c as (typeof SOLANA_CHAINS)[number]),
		)
		const features = wallet.features as Record<string, unknown>
		return (
			hasSolana &&
			(SolanaSignAndSendTransaction in features ||
				SolanaSignTransaction in features)
		)
	})
}

export async function connectSolanaWallet(
	walletName?: string,
): Promise<ConnectedSolanaWallet> {
	const wallets = listSolanaWallets()
	const wallet =
		(walletName ? wallets.find((w) => w.name === walletName) : undefined) ??
		wallets[0]
	if (!wallet) {
		throw new Error(
			"No Solana Wallet Standard wallet found. Install a compatible extension (for example Phantom).",
		)
	}
	const standardConnect = wallet.features["standard:connect"] as
		{ connect: () => Promise<{ accounts: WalletAccount[] }> } | undefined
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

export async function signAndSendSolanaTransaction(opts: {
	connected: ConnectedSolanaWallet
	transaction: Transaction
	connection: Connection
	options?: SendOptions
}): Promise<string> {
	const { connected, transaction, connection } = opts
	const feature = connected.wallet.features[SolanaSignAndSendTransaction] as
		| SolanaSignAndSendTransactionFeature[typeof SolanaSignAndSendTransaction]
		| undefined
	if (feature) {
		const serialized = transaction.serialize({
			requireAllSignatures: false,
			verifySignatures: false,
		})
		const chain =
			(connected.wallet.chains.find((c) => c.startsWith("solana:")) as
				"solana:devnet" | "solana:testnet" | "solana:mainnet" | undefined) ??
			"solana:devnet"
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
