import assert from "node:assert/strict"
import { afterEach, describe, test, vi } from "vitest"
import {
	FLEXIPAY_WALLET_CHAIN,
	isFlexiPayWalletConfigured,
	readPrivyAppId,
} from "../src/flexipayWallet/config.ts"
import { formatUsdcBalance } from "../src/flexipayWallet/formatUsdcBalance.ts"
import { sendFlexiPaySolanaTransaction } from "../src/flexipayWallet/sendFlexiPaySolanaTransaction.ts"

const balances =
	vi.fn<
		(connection: unknown, address: string, mint: string) => Promise<unknown>
	>()
vi.mock("@flexipay/adapter-solana/browser", () => ({
	getSolAndUsdcBalances: (connection: unknown, address: string, mint: string) =>
		balances(connection, address, mint),
}))

const getSolanaConfig = vi.fn<() => Promise<unknown>>()
vi.mock("../src/api/solanaClient.ts", () => ({
	getSolanaConfig: () => getSolanaConfig(),
}))

const { loadFlexiPayBalances } =
	await import("../src/flexipayWallet/balances.ts")

afterEach(() => {
	balances.mockReset()
	getSolanaConfig.mockReset()
})

describe("FlexiPay wallet config", () => {
	test("reads and trims the public Privy app id", () => {
		assert.equal(FLEXIPAY_WALLET_CHAIN, "solana:devnet")
		assert.equal(readPrivyAppId({ VITE_PRIVY_APP_ID: "  app_123 " }), "app_123")
		assert.equal(readPrivyAppId({}), "")
		assert.equal(isFlexiPayWalletConfigured({ VITE_PRIVY_APP_ID: "app" }), true)
		assert.equal(
			isFlexiPayWalletConfigured({ VITE_PRIVY_APP_ID: "   " }),
			false,
		)
		assert.equal(isFlexiPayWalletConfigured({}), false)
	})
})

describe("sendFlexiPaySolanaTransaction", () => {
	test("throws before sending when the wallet cannot send", async () => {
		await assert.rejects(
			() =>
				sendFlexiPaySolanaTransaction(
					{ address: "x" },
					{ serialize: () => [1, 2] },
				),
			/cannot send transactions yet/,
		)
	})

	test("trims the hash, asks for an unsigned serialize, and keeps `this`", async () => {
		const seenConfig: unknown[] = []
		const wallet = {
			address: "x",
			calls: 0,
			async sendTransaction(this: { calls: number }) {
				this.calls += 1
				return { hash: "  sig  " }
			},
		}
		const hash = await sendFlexiPaySolanaTransaction(wallet, {
			serialize: (config) => {
				seenConfig.push(config)
				return Buffer.from([1])
			},
		})
		assert.equal(hash, "sig")
		assert.equal(wallet.calls, 1)
		assert.deepEqual(seenConfig, [
			{ requireAllSignatures: false, verifySignatures: false },
		])
	})

	test("a missing hash field is treated as no signature", async () => {
		await assert.rejects(
			() =>
				sendFlexiPaySolanaTransaction(
					{
						address: "x",
						sendTransaction: async () => ({}) as { hash: string },
					},
					{ serialize: () => new Uint8Array([1]) },
				),
			/no signature/,
		)
	})
})

describe("formatUsdcBalance", () => {
	test("human amount, raw fallback and placeholders", () => {
		assert.equal(formatUsdcBalance(null), "—")
		assert.equal(formatUsdcBalance({ amount: "abc" }), "abc")
		assert.equal(formatUsdcBalance({ amount: "   ", rawAmount: "x" }), "—")
		assert.equal(formatUsdcBalance({}), "—")
		assert.equal(
			formatUsdcBalance({ rawAmount: "1500000" }),
			(1.5).toLocaleString(undefined, { minimumFractionDigits: 2 }),
		)
		assert.equal(
			formatUsdcBalance({ rawAmount: "5", decimals: 2 }),
			(0.05).toLocaleString(undefined, { minimumFractionDigits: 2 }),
		)
	})
})

describe("loadFlexiPayBalances", () => {
	test("needs a public RPC", async () => {
		getSolanaConfig.mockResolvedValue({ publicRpcUrl: null, assets: [] })
		await assert.rejects(
			() => loadFlexiPayBalances("addr"),
			/No public Solana RPC/,
		)
	})

	test("reads SOL and each configured token", async () => {
		getSolanaConfig.mockResolvedValue({
			publicRpcUrl: "https://api.devnet.solana.com",
			assets: [
				{ asset: "TGBP", mint: "TGBP111", decimals: 7 },
				{ asset: "USDC", mint: "USDC111", decimals: 6 },
			],
		})
		balances
			.mockResolvedValueOnce({
				solLamports: 1_500_000_000n,
				usdcMinor: 12_345_000n,
			})
			.mockResolvedValueOnce({
				solLamports: 2_000_000_000n,
				usdcMinor: 2_000_000n,
			})
		const result = await loadFlexiPayBalances("addr")
		assert.equal(result.sol, "2")
		assert.deepEqual(
			result.tokens.map((t) => t.asset),
			["TGBP", "USDC"],
		)
		assert.equal(result.tokens[0]?.amount, "£1.23")
		assert.deepEqual(
			balances.mock.calls.map((c) => [c[1], c[2]]),
			[
				["addr", "TGBP111"],
				["addr", "USDC111"],
			],
		)
	})

	test("fractional SOL and no assets", async () => {
		getSolanaConfig.mockResolvedValue({
			publicRpcUrl: "https://api.devnet.solana.com",
			assets: [{ asset: "USDC", mint: "U", decimals: 6 }],
		})
		balances.mockResolvedValue({ solLamports: 1_050_000_000n, usdcMinor: 0n })
		assert.equal((await loadFlexiPayBalances("a")).sol, "1.05")

		getSolanaConfig.mockResolvedValue({
			publicRpcUrl: "https://api.devnet.solana.com",
			assets: [],
		})
		assert.deepEqual(await loadFlexiPayBalances("a"), { sol: "—", tokens: [] })
	})
})
