import assert from "node:assert/strict"
import {
	SolanaSignAndSendTransaction,
	SolanaSignTransaction,
} from "@solana/wallet-standard-features"
import { Keypair, Transaction } from "@solana/web3.js"
import { type Wallet, type WalletAccount } from "@wallet-standard/base"
import bs58 from "bs58"
import { afterEach, describe, test, vi } from "vitest"
import { ApiError } from "../src/api/client.ts"
import {
	assetLabel,
	formatAssetAmount,
	preferredAssetFromConfig,
} from "../src/solana/assets.ts"
import {
	friendlySolanaPayError,
	SOLANA_PAY_ERROR_COPY as COPY,
} from "../src/solana/friendlySolanaPayError.ts"

const registered: Wallet[] = []
const unregisterListeners = new Set<() => void>()

vi.mock("@wallet-standard/app", () => ({
	getWallets: () => ({
		get: () => registered.slice(),
		on: (event: string, listener: () => void) => {
			if (event === "unregister") unregisterListeners.add(listener)
			return () => unregisterListeners.delete(listener)
		},
	}),
}))

const {
	accountSupportsCluster,
	connectSolanaWallet,
	describeWalletUserError,
	disconnectSolanaWallet,
	listSolanaWallets,
	shortAddress,
	signAndSendSolanaTransaction,
	subscribeSolanaWallets,
	subscribeWalletAccountChanges,
	walletSupportsCluster,
} = await import("../src/solana/walletStandard.ts")

type AnyWallet = Parameters<typeof walletSupportsCluster>[0]

afterEach(() => {
	registered.length = 0
	unregisterListeners.clear()
})

const account = (chains: string[] = ["solana:devnet"]): WalletAccount =>
	({
		address: Keypair.generate().publicKey.toBase58(),
		publicKey: new Uint8Array(32),
		chains,
		features: [],
	}) as WalletAccount

const wallet = (
	name: string,
	features: Record<string, unknown>,
	opts: { chains?: string[]; accounts?: WalletAccount[] } = {},
): AnyWallet =>
	({
		version: "1.0.0",
		name,
		icon: "data:image/svg+xml;base64,PHN2Zy8+",
		chains: opts.chains ?? ["solana:devnet"],
		features,
		accounts: opts.accounts ?? [account()],
	}) as unknown as AnyWallet

const tx = (): Transaction => {
	const t = new Transaction()
	t.feePayer = Keypair.generate().publicKey
	t.recentBlockhash = Keypair.generate().publicKey.toBase58()
	return t
}

describe("walletStandard: discovery and connect", () => {
	test("wallets without Solana chains or sign features are hidden", () => {
		registered.push(
			wallet("EVM", { [SolanaSignTransaction]: {} }, { chains: ["eip155:1"] }),
			wallet("NoFeatures", {}),
			wallet("SignOnly", { [SolanaSignTransaction]: {} }),
			{
				...wallet("NoChains", { [SolanaSignTransaction]: {} }),
				chains: undefined,
			} as unknown as AnyWallet,
		)
		assert.deepEqual(
			listSolanaWallets().map((w) => w.name),
			["SignOnly"],
		)
	})

	test("connect without standard:connect uses the existing account; unknown name falls back", async () => {
		registered.push(wallet("Backpack", { [SolanaSignTransaction]: {} }))
		const connected = await connectSolanaWallet("Missing")
		assert.equal(connected.wallet.name, "Backpack")
		assert.equal(connected.address, connected.account.address)
	})

	test("connect that returns no accounts falls back, or fails clearly", async () => {
		const fallback = account()
		registered.push(
			wallet(
				"Phantom",
				{
					[SolanaSignTransaction]: {},
					"standard:connect": { connect: async () => ({ accounts: [] }) },
				},
				{ accounts: [fallback] },
			),
		)
		assert.equal((await connectSolanaWallet()).account, fallback)

		registered.length = 0
		registered.push(
			wallet("Empty", { [SolanaSignTransaction]: {} }, { accounts: [] }),
		)
		await assert.rejects(() => connectSolanaWallet(), /returned no account/)
	})

	test("including the harness skips the harness-only hint", async () => {
		await assert.rejects(
			() => connectSolanaWallet(undefined, { includeTestHarness: true }),
			/No Solana wallet found/,
		)
	})

	test("disconnect calls standard:disconnect when present", async () => {
		const disconnect = vi.fn(async () => undefined)
		await disconnectSolanaWallet(
			wallet("A", { "standard:disconnect": { disconnect } }),
		)
		assert.equal(disconnect.mock.calls.length, 1)
		await disconnectSolanaWallet(wallet("B", {}))
	})

	test("subscriptions: unregister fires; unsubscribe removes listeners", () => {
		let hits = 0
		const off = subscribeSolanaWallets(() => {
			hits += 1
		})
		for (const listener of unregisterListeners) listener()
		assert.equal(hits, 1)
		off()
		assert.equal(unregisterListeners.size, 0)
	})

	test("account change events pass accounts, or re-read the wallet", () => {
		let handler: (...args: unknown[]) => void = () => undefined
		const accounts = [account()]
		const w = wallet(
			"A",
			{
				"standard:events": {
					on: (_event: string, listener: (...args: unknown[]) => void) => {
						handler = listener
						return () => undefined
					},
				},
			},
			{ accounts },
		)
		const seen: (readonly WalletAccount[])[] = []
		const off = subscribeWalletAccountChanges(w, (a) => seen.push(a))
		const fresh = [account()]
		handler({ accounts: fresh })
		handler(undefined)
		assert.deepEqual(seen, [fresh, accounts])
		off()

		const noop = subscribeWalletAccountChanges(wallet("B", {}), () => undefined)
		assert.equal(noop(), undefined)
	})
})

describe("walletStandard: cluster checks and signing", () => {
	test("accounts without chains follow the wallet; wallets without chains support nothing", () => {
		assert.equal(accountSupportsCluster(account([]), "devnet"), true)
		assert.equal(
			accountSupportsCluster(account(["solana:testnet"]), "testnet"),
			true,
		)
		const noChains = {
			...wallet("X", {}),
			chains: undefined,
		} as unknown as AnyWallet
		assert.equal(walletSupportsCluster(noChains, "devnet"), false)
		const noAccountChains = {
			...account(),
			chains: undefined,
		} as unknown as WalletAccount
		assert.equal(accountSupportsCluster(noAccountChains, "devnet"), true)
	})

	test("account not enabled for the cluster is refused before signing", async () => {
		const w = wallet("A", { [SolanaSignAndSendTransaction]: {} })
		await assert.rejects(
			() =>
				signAndSendSolanaTransaction({
					connected: {
						wallet: w,
						account: account(["solana:mainnet"]),
						address: "x",
					},
					transaction: tx(),
					connection: {} as never,
				}),
			/not enabled for solana:devnet/,
		)
	})

	test("signAndSend normalizes preflight commitment for Wallet Standard", async () => {
		const seen: unknown[] = []
		const signature = new Uint8Array(64).fill(3)
		const w = wallet("A", {
			[SolanaSignAndSendTransaction]: {
				signAndSendTransaction: async (input: { options?: unknown }) => {
					seen.push(input.options)
					return [{ signature }]
				},
			},
		})
		const acct = w.accounts[0] as WalletAccount
		const send = (options?: object) =>
			signAndSendSolanaTransaction({
				connected: { wallet: w, account: acct, address: acct.address },
				transaction: tx(),
				connection: {} as never,
				options: options as never,
			})
		assert.equal(await send(), bs58.encode(signature))
		await send({ skipPreflight: true })
		await send({ preflightCommitment: "finalized" })
		await send({ preflightCommitment: "max" })
		assert.deepEqual(seen, [
			undefined,
			{ skipPreflight: true, preflightCommitment: undefined },
			{ preflightCommitment: "finalized" },
			{ preflightCommitment: "confirmed" },
		])
	})

	test("signAndSend without a signature fails", async () => {
		const w = wallet("A", {
			[SolanaSignAndSendTransaction]: {
				signAndSendTransaction: async () => [],
			},
		})
		const acct = w.accounts[0] as WalletAccount
		await assert.rejects(
			() =>
				signAndSendSolanaTransaction({
					connected: { wallet: w, account: acct, address: acct.address },
					transaction: tx(),
					connection: {} as never,
				}),
			/did not return a transaction signature/,
		)
	})

	test("sign-only wallets sign, then the connection broadcasts", async () => {
		const payer = Keypair.generate()
		const original = tx()
		original.feePayer = payer.publicKey
		const w = wallet("A", {
			[SolanaSignTransaction]: {
				signTransaction: async () => {
					original.sign(payer)
					return [{ signedTransaction: original.serialize() }]
				},
			},
		})
		const acct = w.accounts[0] as WalletAccount
		const sendRaw = vi.fn(async (_wire: unknown, _opts: unknown) => "sig123")
		const signature = await signAndSendSolanaTransaction({
			connected: { wallet: w, account: acct, address: acct.address },
			transaction: original,
			connection: { sendRawTransaction: sendRaw } as never,
			options: { skipPreflight: true },
		})
		assert.equal(signature, "sig123")
		assert.deepEqual(sendRaw.mock.calls[0]?.[1], {
			skipPreflight: true,
			preflightCommitment: "confirmed",
		})
	})

	test("sign-only wallet returning nothing, and wallets that cannot sign", async () => {
		const empty = wallet("A", {
			[SolanaSignTransaction]: { signTransaction: async () => [] },
		})
		const acct = empty.accounts[0] as WalletAccount
		await assert.rejects(
			() =>
				signAndSendSolanaTransaction({
					connected: { wallet: empty, account: acct, address: "" },
					transaction: tx(),
					connection: {} as never,
				}),
			/did not return a signed transaction/,
		)
		const none = wallet("B", {})
		await assert.rejects(
			() =>
				signAndSendSolanaTransaction({
					connected: { wallet: none, account: acct, address: "" },
					transaction: tx(),
					connection: {} as never,
				}),
			/cannot sign Solana transactions/,
		)
	})
})

describe("walletStandard: user copy and addresses", () => {
	test("describeWalletUserError", () => {
		for (const raw of [
			"Request denied",
			"user cancelled",
			"Canceled by user",
		]) {
			assert.match(describeWalletUserError(new Error(raw)), /Wallet rejected/)
		}
		assert.equal(
			describeWalletUserError("Switch to devnet"),
			"Switch to devnet",
		)
		assert.equal(
			describeWalletUserError(new Error("No Solana wallet found")),
			"No Solana wallet found",
		)
		assert.equal(describeWalletUserError(new Error("boom")), "boom")
		assert.equal(describeWalletUserError(42), "Wallet action failed")
	})

	test("shortAddress keeps short strings", () => {
		assert.equal(shortAddress("abc"), "abc")
		assert.equal(shortAddress("1234567890"), "1234…7890")
	})
})

describe("assets", () => {
	test("labels and formatting edge cases", () => {
		assert.equal(assetLabel("TGBP"), "tGBP (£)")
		assert.equal(formatAssetAmount("TGBP", "abc", 7), "£—")
		assert.equal(formatAssetAmount("USDC", "-1", 6), "—")
		assert.equal(formatAssetAmount("TGBP", 150n, 2), "£1.50")
		assert.equal(formatAssetAmount("TGBP", "+5", 0), "£5.00")
		// Half-up at 7dp: 0.0049999 → £0.00, 0.005 → £0.01.
		assert.equal(formatAssetAmount("TGBP", "49999", 7), "£0.00")
		assert.equal(formatAssetAmount("TGBP", "50000", 7), "£0.01")
		assert.equal(
			formatAssetAmount("USDC", 1_500_000, 6),
			(1.5).toLocaleString(),
		)
		assert.equal(formatAssetAmount("USDC", "7", 0), "7")
	})

	test("preferredAssetFromConfig picks USDC when only USDC is listed", () => {
		const usdc = { asset: "USDC" as const, mint: "U", decimals: 6 }
		assert.equal(
			preferredAssetFromConfig([usdc], { mint: "F", decimals: 9 }),
			usdc,
		)
		assert.deepEqual(preferredAssetFromConfig([], { mint: "F", decimals: 9 }), {
			asset: "USDC",
			mint: "F",
			decimals: 9,
		})
	})
})

describe("friendlySolanaPayError branches", () => {
	test("ApiError expiry by code or message", () => {
		for (const err of [
			new ApiError(400, "quote_expired", "x"),
			new ApiError(400, "expired", "x"),
			new ApiError(400, "bad", "Quote expiry passed"),
		]) {
			assert.equal(friendlySolanaPayError(err), COPY.EXPIRED)
		}
		assert.equal(
			friendlySolanaPayError(new ApiError(400, "x", "", ["user rejected"])),
			COPY.USER_REJECTED,
		)
	})

	test("message heuristics", () => {
		const cases: Array<[string, string]> = [
			["Mainnet wallet but payment is devnet", COPY.WRONG_CLUSTER],
			["cluster mismatch", COPY.WRONG_CLUSTER],
			["Switch the wallet network", COPY.WRONG_CLUSTER],
			["insufficient lamports 0", COPY.NO_SOL_FEES],
			["Attempt to debit: insufficient funds for rent", COPY.NO_SOL_FEES],
			["not enough tGBP", COPY.INSUFFICIENT_USDC],
			[
				"Transaction simulation failed: insufficient funds",
				COPY.INSUFFICIENT_USDC,
			],
			["custom program error: 0x1", COPY.INSUFFICIENT_USDC],
			["Blockhash no longer valid", COPY.EXPIRED],
			["Request denied", COPY.USER_REJECTED],
			["[1,2]", COPY.FALLBACK],
			["something else", COPY.FALLBACK],
		]
		for (const [raw, expected] of cases) {
			assert.equal(friendlySolanaPayError(new Error(raw)), expected, raw)
		}
		assert.equal(friendlySolanaPayError(undefined), COPY.FALLBACK)
		assert.equal(friendlySolanaPayError({ message: "x" }), COPY.FALLBACK)
	})

	// Fixed (was BUG): only error 0x1 maps to INSUFFICIENT_USDC, not 0x10/0x11.
	test("custom program error 0x11 (frozen account) is not reported as insufficient tokens", () => {
		assert.notEqual(
			friendlySolanaPayError(
				new Error("Transaction simulation failed: custom program error: 0x11"),
			),
			COPY.INSUFFICIENT_USDC,
		)
	})
})
