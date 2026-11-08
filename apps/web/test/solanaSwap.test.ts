import assert from "node:assert/strict"
import { afterEach, describe, test, vi } from "vitest"
import { confirmSolanaSwap, requestSolanaSwap } from "../src/api/client.ts"
import { parseSolanaConfig } from "../src/api/solanaClient.ts"
import { formatUnits, waitForSwap } from "../src/payments/solanaSwap.ts"

// CCR-49: tGBP → USDC swap step (Jupiter) in the sender's wallet.

const wallet = "ATgdUGhxWZZbh7FC6SJgT4M1GLExHZGzirn3jMaA8ZLG"
const TGBP = "2zMqyX4AYCk6mgy5UZ2S7zUaLxwERhK5WjqDzkPPbSpW"
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const sig = "5".repeat(88)

type Call = { url: string; init: RequestInit | undefined }
let calls: Call[] = []
const stubFetch = (status: number, body: unknown) =>
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, init })
			return new Response(JSON.stringify(body), { status })
		}),
	)

afterEach(() => {
	calls = []
	vi.unstubAllGlobals()
})

describe("formatUnits", () => {
	test("formats base units with grouping and rounds down", () => {
		assert.equal(formatUnits("18675697817", 9), "18.67")
		assert.equal(formatUnits("100000000", 6), "100.00")
		assert.equal(formatUnits("1234567000000", 6), "1,234,567.00")
		assert.equal(formatUnits("5", 6), "0.00")
		assert.equal(formatUnits("5", 0, 0), "5")
		assert.equal(formatUnits("12", 0), "12.00")
		assert.equal(formatUnits("nope", 6), "0")
	})
})

describe("waitForSwap", () => {
	const reply = (status: "confirmed" | "pending") => ({
		status,
		signature: sig,
		heldAmount: "1",
		requiredAmount: "1",
	})

	test("polls until Solana confirms the swap", async () => {
		const seen = ["pending", "pending", "confirmed"] as const
		let i = 0
		const sleeps: number[] = []
		const out = await waitForSwap(async () => reply(seen[i++]!), {
			intervalMs: 5,
			sleep: async (ms) => {
				sleeps.push(ms)
			},
		})
		assert.equal(out.status, "confirmed")
		assert.deepEqual(sleeps, [5, 5])
	})

	test("gives up after the timeout", async () => {
		await assert.rejects(
			waitForSwap(async () => reply("pending"), {
				timeoutMs: 0,
				sleep: async () => {},
			}),
			/not landed/,
		)
	})

	test("stops on an API error", async () => {
		await assert.rejects(
			waitForSwap(async () => {
				throw new Error("swap_failed")
			}),
			/swap_failed/,
		)
	})
})

describe("swap client", () => {
	test("requests the swap for the sender's wallet", async () => {
		stubFetch(200, {
			status: "ready",
			provider: "jupiter",
			transaction: "AQID",
			inputAsset: "TGBP",
			inputMint: TGBP,
			inputDecimals: 9,
			inputAmount: "74700000000",
			inputMaxAmount: "75073500000",
			outputMint: USDC,
			outputDecimals: 6,
			outputAmount: "100000000",
			requiredAmount: "100000000",
			heldAmount: "0",
			slippageBps: 50,
			priceImpact: 0.0001,
			route: ["Whirlpool"],
		})
		const out = await requestSolanaSwap("pay_1", wallet)
		assert.equal(out.status, "ready")
		assert.ok(calls[0]!.url.endsWith("/v1/payments/pay_1/solana-swap"))
		assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
			walletAddress: wallet,
			inputAsset: "TGBP",
		})
	})

	test("confirms the swap signature", async () => {
		stubFetch(200, {
			status: "confirmed",
			signature: sig,
			heldAmount: "100000000",
			requiredAmount: "100000000",
		})
		const out = await confirmSolanaSwap("pay_1", wallet, sig)
		assert.equal(out.status, "confirmed")
		assert.ok(calls[0]!.url.endsWith("/v1/payments/pay_1/solana-swap/confirm"))
		assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
			walletAddress: wallet,
			signature: sig,
		})
	})
})

describe("parseSolanaConfig swapInputAssets", () => {
	test("keeps only known swap assets and defaults to none", () => {
		const base = { cluster: "mainnet-beta", usdcMint: USDC, usdcDecimals: 6 }
		assert.deepEqual(
			parseSolanaConfig({ ...base, swapInputAssets: ["TGBP", "XYZ"] })
				.swapInputAssets,
			["TGBP"],
		)
		assert.deepEqual(parseSolanaConfig(base).swapInputAssets, [])
	})
})
