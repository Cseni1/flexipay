import assert from "node:assert/strict"
import {
	SolanaSignAndSendTransaction,
	SolanaSignTransaction,
} from "@solana/wallet-standard-features"
import {
	Keypair,
	Transaction,
	TransactionMessage,
	VersionedTransaction,
} from "@solana/web3.js"
import { type Wallet, type WalletAccount } from "@wallet-standard/base"
import { afterEach, describe, test, vi } from "vitest"

const registered: Wallet[] = []
const registerListeners = new Set<() => void>()
const unregisterListeners = new Set<() => void>()

vi.mock("@wallet-standard/app", () => ({
	getWallets: () => ({
		get: () => registered.slice(),
		on: (event: string, listener: () => void) => {
			const set = event === "register" ? registerListeners : unregisterListeners
			set.add(listener)
			return () => set.delete(listener)
		},
	}),
}))

const {
	accountSupportsCluster,
	clusterToChainId,
	connectSolanaWallet,
	describeWalletUserError,
	FP_DEVNET_TEST_WALLET_NAME,
	isTestHarnessWallet,
	listSolanaWallets,
	PREFERRED_USER_WALLETS,
	signAndSendSolanaTransaction,
	signAndSendVersionedSolanaTransaction,
	subscribeSolanaWallets,
	walletSupportsCluster,
} = await import("../src/solana/walletStandard.ts")

afterEach(() => {
	registered.length = 0
	registerListeners.clear()
	unregisterListeners.clear()
})

const makeAccount = (
	address: string,
	chains: string[] = ["solana:devnet"],
): WalletAccount =>
	({
		address,
		publicKey: new Uint8Array(32),
		chains,
		features: [],
	}) as WalletAccount

const makeWallet = (opts: {
	name: string
	chains?: string[]
	accounts?: WalletAccount[]
	connectReject?: boolean
	signReject?: boolean
	signAndSend?: boolean
}): Wallet => {
	const accounts = opts.accounts ?? [
		makeAccount(Keypair.generate().publicKey.toBase58()),
	]
	const features: Record<string, unknown> = {
		"standard:connect": {
			connect: async () => {
				if (opts.connectReject) throw new Error("User rejected the request")
				return { accounts }
			},
		},
		"standard:disconnect": {
			disconnect: async () => undefined,
		},
		"standard:events": {
			on: () => () => undefined,
		},
	}
	if (opts.signAndSend !== false) {
		features[SolanaSignAndSendTransaction] = {
			signAndSendTransaction: async () => {
				if (opts.signReject) throw new Error("User rejected the request")
				return [{ signature: new Uint8Array(64).fill(7) }]
			},
		}
	} else {
		features[SolanaSignTransaction] = {
			signTransaction: async () => {
				if (opts.signReject) throw new Error("User rejected the request")
				const tx = new Transaction()
				return [
					{
						signedTransaction: tx.serialize({
							requireAllSignatures: false,
							verifySignatures: false,
						}),
					},
				]
			},
		}
	}
	return {
		version: "1.0.0",
		name: opts.name,
		icon: "data:image/svg+xml;base64,PHN2Zy8+",
		chains: opts.chains ?? ["solana:devnet"],
		features,
		accounts,
	} as Wallet
}

describe("TASK 04 walletStandard", () => {
	test("clusterToChainId maps FlexiPay clusters", () => {
		assert.equal(clusterToChainId("devnet"), "solana:devnet")
		assert.equal(clusterToChainId("testnet"), "solana:testnet")
		assert.equal(clusterToChainId("mainnet-beta"), "solana:mainnet")
	})

	test("prefers Phantom over Solflare over other wallets; hides harness by default", () => {
		registered.push(
			makeWallet({ name: "Other Wallet" }),
			makeWallet({ name: FP_DEVNET_TEST_WALLET_NAME }),
			makeWallet({ name: "Solflare" }),
			makeWallet({ name: "Phantom" }),
		)
		const names = listSolanaWallets().map((w) => w.name)
		assert.deepEqual(names, ["Phantom", "Solflare", "Other Wallet"])
		assert.equal(names.includes(FP_DEVNET_TEST_WALLET_NAME), false)

		const withHarness = listSolanaWallets({ includeTestHarness: true }).map(
			(w) => w.name,
		)
		assert.equal(withHarness.includes(FP_DEVNET_TEST_WALLET_NAME), true)
		assert.ok(PREFERRED_USER_WALLETS.includes("Phantom"))
	})

	test("connectSolanaWallet connects preferred Phantom and surfaces rejection", async () => {
		registered.push(
			makeWallet({ name: "Solflare" }),
			makeWallet({ name: "Phantom" }),
		)
		const connected = await connectSolanaWallet()
		assert.equal(connected.wallet.name, "Phantom")
		assert.ok(connected.address.length > 20)

		registered.length = 0
		registered.push(makeWallet({ name: "Phantom", connectReject: true }))
		await assert.rejects(() => connectSolanaWallet("Phantom"), /rejected/i)
	})

	test("missing wallet and harness-only messages", async () => {
		await assert.rejects(() => connectSolanaWallet(), /Install Phantom/)

		registered.push(makeWallet({ name: FP_DEVNET_TEST_WALLET_NAME }))
		assert.equal(isTestHarnessWallet(registered[0]!), true)
		await assert.rejects(
			() => connectSolanaWallet(),
			/Only the automated test wallet/,
		)
	})

	test("network mismatch blocks signAndSend for wrong cluster", async () => {
		const wallet = makeWallet({
			name: "Phantom",
			chains: ["solana:mainnet"],
			accounts: [
				makeAccount(Keypair.generate().publicKey.toBase58(), [
					"solana:mainnet",
				]),
			],
		})
		registered.push(wallet)
		const connected = await connectSolanaWallet("Phantom")
		assert.equal(walletSupportsCluster(connected.wallet, "devnet"), false)
		assert.equal(accountSupportsCluster(connected.account, "devnet"), false)

		const fakeConnection = {
			sendRawTransaction: async () => "should-not-run",
		} as never

		await assert.rejects(
			() =>
				signAndSendSolanaTransaction({
					connected,
					transaction: new Transaction(),
					connection: fakeConnection,
					cluster: "devnet",
				}),
			/Devnet|solana:devnet/i,
		)
	})

	const stubTransaction = (): Transaction => {
		const tx = new Transaction()
		tx.feePayer = Keypair.generate().publicKey
		tx.recentBlockhash = Keypair.generate().publicKey.toBase58()
		return tx
	}

	test("signAndSend succeeds on matching Devnet wallet", async () => {
		registered.push(makeWallet({ name: "Phantom", chains: ["solana:devnet"] }))
		const connected = await connectSolanaWallet("Phantom")
		const fakeConnection = {
			sendRawTransaction: async () => "should-not-run",
		} as never
		const signature = await signAndSendSolanaTransaction({
			connected,
			transaction: stubTransaction(),
			connection: fakeConnection,
			// default cluster is devnet
		})
		assert.equal(typeof signature, "string")
		assert.ok(signature.length > 20)
	})

	test("sign rejection maps to safe user copy", async () => {
		registered.push(
			makeWallet({
				name: "Phantom",
				signReject: true,
				chains: ["solana:devnet"],
			}),
		)
		const connected = await connectSolanaWallet("Phantom")
		const fakeConnection = { sendRawTransaction: async () => "" } as never
		try {
			await signAndSendSolanaTransaction({
				connected,
				transaction: stubTransaction(),
				connection: fakeConnection,
				cluster: "devnet",
			})
			assert.fail("expected rejection")
		} catch (cause) {
			const msg = describeWalletUserError(cause)
			assert.match(msg, /rejected/i)
			assert.equal(msg.toLowerCase().includes("secret"), false)
			assert.equal(msg.toLowerCase().includes("private"), false)
		}
	})

	test("subscribeSolanaWallets fires on register", () => {
		let hits = 0
		const off = subscribeSolanaWallets(() => {
			hits += 1
		})
		for (const listener of registerListeners) listener()
		assert.equal(hits, 1)
		off()
	})
})

describe("CCR-45 signAndSendVersionedSolanaTransaction (BlindPay delegation)", () => {
	const payer = Keypair.generate().publicKey
	const versionedBase64 = () => {
		const message = new TransactionMessage({
			payerKey: payer,
			recentBlockhash: "11111111111111111111111111111111",
			instructions: [],
		}).compileToV0Message()
		return Buffer.from(new VersionedTransaction(message).serialize()).toString(
			"base64",
		)
	}

	test("signs BlindPay's base64 transaction and returns a base58 signature", async () => {
		registered.push(makeWallet({ name: "Phantom" }))
		const connected = await connectSolanaWallet("Phantom")
		const signature = await signAndSendVersionedSolanaTransaction({
			connected,
			transactionBase64: versionedBase64(),
		})
		assert.match(signature, /^[1-9A-HJ-NP-Za-km-z]{60,90}$/)
	})

	test("refuses mainnet in this build", async () => {
		registered.push(makeWallet({ name: "Phantom" }))
		const connected = await connectSolanaWallet("Phantom")
		await assert.rejects(
			signAndSendVersionedSolanaTransaction({
				connected,
				transactionBase64: versionedBase64(),
				cluster: "mainnet-beta",
			}),
			/devnet/,
		)
	})

	test("refuses a wallet on the wrong network", async () => {
		registered.push(
			makeWallet({
				name: "Phantom",
				chains: ["solana:devnet"],
			}),
		)
		const connected = await connectSolanaWallet("Phantom")
		;(connected.wallet as { chains: string[] }).chains = ["solana:mainnet"]
		await assert.rejects(
			signAndSendVersionedSolanaTransaction({
				connected,
				transactionBase64: versionedBase64(),
			}),
			/Devnet/,
		)
	})

	test("refuses a wallet that cannot sign and send", async () => {
		registered.push(makeWallet({ name: "Phantom", signAndSend: false }))
		const connected = await connectSolanaWallet("Phantom")
		await assert.rejects(
			signAndSendVersionedSolanaTransaction({
				connected,
				transactionBase64: versionedBase64(),
			}),
			/cannot sign/,
		)
	})

	test("rejects bytes that are not a transaction", async () => {
		registered.push(makeWallet({ name: "Phantom" }))
		const connected = await connectSolanaWallet("Phantom")
		await assert.rejects(
			signAndSendVersionedSolanaTransaction({
				connected,
				transactionBase64: "AAAA",
			}),
		)
	})
})
