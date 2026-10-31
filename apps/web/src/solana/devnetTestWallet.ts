/**
 * Wallet Standard harness for local/DEVNET browser proofs.
 * Registers only when `window.__FP_SOLANA_TEST_WALLET__` is set (Playwright inject).
 * Never logs or persists the secret key.
 */
import {
	SolanaSignAndSendTransaction,
	SolanaSignTransaction,
	type SolanaSignAndSendTransactionFeature,
	type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features"
import { Connection, Keypair, Transaction } from "@solana/web3.js"
import {
	type Wallet,
	type WalletAccount,
	type WalletIcon,
} from "@wallet-standard/base"
import { registerWallet } from "@wallet-standard/wallet"
import bs58 from "bs58"

export const FP_DEVNET_TEST_WALLET_NAME = "FlexiPay Devnet Test Wallet"

type TestWalletBootstrap = {
	/** Secret key as JSON number array (ed25519). */
	secretKey: number[]
	/** Optional RPC for sign-and-send. */
	rpcUrl?: string
}

declare global {
	interface Window {
		__FP_SOLANA_TEST_WALLET__?: TestWalletBootstrap
		__FP_SOLANA_TEST_WALLET_READY__?: boolean
	}
}

const ICON =
	"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOCIgZmlsbD0iIzBjNGE2ZSIvPjx0ZXh0IHg9IjE2IiB5PSIyMCIgZm9udC1zaXplPSIxMCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iI2ZmZiI+RlA8L3RleHQ+PC9zdmc+" as WalletIcon

class FlexiPayDevnetTestWallet implements Wallet {
	readonly version = "1.0.0" as const
	readonly name = FP_DEVNET_TEST_WALLET_NAME
	readonly icon = ICON
	readonly chains = ["solana:devnet"] as const
	#keypair: Keypair
	#rpcUrl: string
	#accounts: WalletAccount[] = []
	#listeners = new Set<() => void>()

	readonly features: Wallet["features"] &
		SolanaSignAndSendTransactionFeature &
		SolanaSignTransactionFeature & {
			"standard:connect": {
				version: "1.0.0"
				connect: () => Promise<{ accounts: WalletAccount[] }>
			}
			"standard:disconnect": {
				version: "1.0.0"
				disconnect: () => Promise<void>
			}
			"standard:events": {
				version: "1.0.0"
				on: (event: string, listener: () => void) => () => void
			}
		}

	constructor(keypair: Keypair, rpcUrl: string) {
		this.#keypair = keypair
		this.#rpcUrl = rpcUrl
		this.features = {
			"standard:connect": {
				version: "1.0.0",
				connect: async () => {
					this.#accounts = [this.#account()]
					this.#emit()
					return { accounts: this.accounts }
				},
			},
			"standard:disconnect": {
				version: "1.0.0",
				disconnect: async () => {
					this.#accounts = []
					this.#emit()
				},
			},
			"standard:events": {
				version: "1.0.0",
				on: (_event, listener) => {
					this.#listeners.add(listener)
					return () => this.#listeners.delete(listener)
				},
			},
			[SolanaSignAndSendTransaction]: {
				version: "1.0.0",
				supportedTransactionVersions: ["legacy"],
				signAndSendTransaction: async (...inputs) => {
					const connection = new Connection(this.#rpcUrl, "confirmed")
					const outputs = []
					for (const input of inputs) {
						const tx = Transaction.from(input.transaction)
						tx.partialSign(this.#keypair)
						const signature = await connection.sendRawTransaction(
							tx.serialize(),
							{
								skipPreflight: false,
								preflightCommitment: "confirmed",
								...(input.options ?? {}),
							},
						)
						await connection.confirmTransaction(signature, "confirmed")
						outputs.push({ signature: bs58.decode(signature) })
					}
					return outputs
				},
			},
			[SolanaSignTransaction]: {
				version: "1.0.0",
				supportedTransactionVersions: ["legacy"],
				signTransaction: async (...inputs) => {
					const outputs = []
					for (const input of inputs) {
						const tx = Transaction.from(input.transaction)
						tx.partialSign(this.#keypair)
						outputs.push({
							signedTransaction: tx.serialize({
								requireAllSignatures: false,
								verifySignatures: false,
							}),
						})
					}
					return outputs
				},
			},
		}
	}

	get accounts(): readonly WalletAccount[] {
		return this.#accounts
	}

	#account(): WalletAccount {
		const publicKey = this.#keypair.publicKey.toBytes()
		return {
			address: this.#keypair.publicKey.toBase58(),
			publicKey,
			chains: ["solana:devnet"],
			features: [SolanaSignAndSendTransaction, SolanaSignTransaction],
		}
	}

	#emit(): void {
		for (const listener of this.#listeners) listener()
	}
}

let registered = false

/** Call once from app bootstrap. No-op unless the Playwright bootstrap object is present. */
export function maybeRegisterDevnetTestWallet(): void {
	if (registered || typeof window === "undefined") return
	const bootstrap = window.__FP_SOLANA_TEST_WALLET__
	if (!bootstrap?.secretKey?.length) return
	const keypair = Keypair.fromSecretKey(Uint8Array.from(bootstrap.secretKey))
	const rpcUrl = bootstrap.rpcUrl?.trim() || "https://api.devnet.solana.com"
	registerWallet(new FlexiPayDevnetTestWallet(keypair, rpcUrl))
	registered = true
	window.__FP_SOLANA_TEST_WALLET_READY__ = true
	// Drop the bootstrap payload from the window so later page scripts cannot re-read it easily.
	try {
		delete window.__FP_SOLANA_TEST_WALLET__
	} catch {
		window.__FP_SOLANA_TEST_WALLET__ = undefined
	}
}
