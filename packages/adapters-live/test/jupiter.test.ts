import { describe, expect, it } from "vitest"
import {
	JupiterClient,
	JupiterError,
	JUPITER_KEYED_BASE,
	JUPITER_LITE_BASE,
	type FetchLike,
} from "../src/index.ts"

// CCR-49: Jupiter client against a fake of the documented swap API (no network).

const TGBP = "2zMqyX4AYCk6mgy5UZ2S7zUaLxwERhK5WjqDzkPPbSpW"
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"

const QUOTE = {
	inputMint: TGBP,
	outputMint: USDC,
	inAmount: "18675697817",
	outAmount: "25000000",
	otherAmountThreshold: "18769076307",
	swapMode: "ExactOut",
	slippageBps: 50,
	priceImpactPct: "0.0001",
	routePlan: [{ swapInfo: { label: "Whirlpool" } }, { swapInfo: {} }],
}

type Call = { url: string; method: string; headers: Record<string, string>; body?: string }

function fake(
	reply: (call: Call) => { status: number; body: unknown },
): { fetch: FetchLike; calls: Call[] } {
	const calls: Call[] = []
	return {
		calls,
		fetch: async (url, init) => {
			const call = { url, method: init.method, headers: init.headers, body: init.body }
			calls.push(call)
			const r = reply(call)
			return {
				status: r.status,
				text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
			}
		},
	}
}

const ask = { inputMint: TGBP, outputMint: USDC, amount: 25_000_000n, slippageBps: 50 }

describe("JupiterClient", () => {
	it("quotes ExactOut on the free endpoint and keeps the raw quote", async () => {
		const f = fake(() => ({ status: 200, body: QUOTE }))
		const q = await new JupiterClient({ fetch: f.fetch }).quoteExactOut(ask)
		expect(f.calls[0]!.url.startsWith(`${JUPITER_LITE_BASE}/quote?`)).toBe(true)
		const params = new URL(f.calls[0]!.url).searchParams
		expect(params.get("swapMode")).toBe("ExactOut")
		expect(params.get("amount")).toBe("25000000")
		expect(f.calls[0]!.headers["x-api-key"]).toBeUndefined()
		expect(q).toMatchObject({
			inAmount: "18675697817",
			outAmount: "25000000",
			maxInAmount: "18769076307",
			priceImpact: 0.0001,
			route: ["Whirlpool"],
		})
		expect(q.raw).toEqual(QUOTE)
	})

	it("uses the keyed endpoint and header when an API key is set", async () => {
		const f = fake(() => ({ status: 200, body: QUOTE }))
		await new JupiterClient({ fetch: f.fetch, apiKey: " k1 " }).quoteExactOut(ask)
		expect(f.calls[0]!.url.startsWith(`${JUPITER_KEYED_BASE}/quote?`)).toBe(true)
		expect(f.calls[0]!.headers["x-api-key"]).toBe("k1")
	})

	it("maps no route, outages and odd quotes to JupiterError", async () => {
		const noRoute = fake(() => ({ status: 400, body: { error: "No routes found" } }))
		await expect(
			new JupiterClient({ fetch: noRoute.fetch }).quoteExactOut(ask),
		).rejects.toMatchObject({ code: "no_route", message: "No routes found" })

		const down = fake(() => ({ status: 503, body: "" }))
		await expect(
			new JupiterClient({ fetch: down.fetch }).quoteExactOut(ask),
		).rejects.toMatchObject({ code: "jupiter_unavailable" })

		const thrown: FetchLike = async () => {
			throw new Error("socket")
		}
		await expect(
			new JupiterClient({ fetch: thrown }).quoteExactOut(ask),
		).rejects.toMatchObject({ code: "jupiter_unavailable" })

		for (const bad of [
			{ ...QUOTE, outputMint: TGBP },
			{ ...QUOTE, swapMode: "ExactIn" },
			{ ...QUOTE, inAmount: "1.5" },
			{ ...QUOTE, outAmount: "24999999" },
			{ ...QUOTE, otherAmountThreshold: undefined },
		]) {
			const f = fake(() => ({ status: 200, body: bad }))
			await expect(
				new JupiterClient({ fetch: f.fetch }).quoteExactOut(ask),
			).rejects.toMatchObject({ code: "bad_response" })
		}
	})

	it("treats a non-numeric price impact as the worst case", async () => {
		const f = fake(() => ({ status: 200, body: { ...QUOTE, priceImpactPct: "abc", routePlan: null } }))
		const q = await new JupiterClient({ fetch: f.fetch }).quoteExactOut(ask)
		expect(q.priceImpact).toBe(1)
		expect(q.route).toEqual([])
	})

	it("rejects bad inputs before calling Jupiter", async () => {
		const f = fake(() => ({ status: 200, body: QUOTE }))
		const c = new JupiterClient({ fetch: f.fetch })
		await expect(c.quoteExactOut({ ...ask, inputMint: "nope" })).rejects.toBeInstanceOf(JupiterError)
		await expect(c.quoteExactOut({ ...ask, amount: 0n })).rejects.toBeInstanceOf(JupiterError)
		expect(f.calls).toHaveLength(0)
	})

	it("builds the unsigned swap transaction for the sender's wallet", async () => {
		const f = fake((call) =>
			call.url.endsWith("/quote") || call.url.includes("/quote?")
				? { status: 200, body: QUOTE }
				: { status: 200, body: { swapTransaction: "AQID", lastValidBlockHeight: 42 } },
		)
		const c = new JupiterClient({ fetch: f.fetch, baseUrl: "https://example.test/swap/v1/" })
		const quote = await c.quoteExactOut(ask)
		const out = await c.swapTransaction({ quote, userPublicKey: WALLET })
		expect(out).toEqual({ transaction: "AQID", lastValidBlockHeight: 42 })
		const swapCall = f.calls[1]!
		expect(swapCall.url).toBe("https://example.test/swap/v1/swap")
		const body = JSON.parse(swapCall.body!)
		expect(body.userPublicKey).toBe(WALLET)
		expect(body.quoteResponse).toEqual(QUOTE)
	})

	it("rejects a failed or empty swap response and a bad wallet", async () => {
		const quote = await new JupiterClient({
			fetch: fake(() => ({ status: 200, body: QUOTE })).fetch,
		}).quoteExactOut(ask)
		const failed = fake(() => ({ status: 500, body: {} }))
		await expect(
			new JupiterClient({ fetch: failed.fetch }).swapTransaction({ quote, userPublicKey: WALLET }),
		).rejects.toMatchObject({ code: "jupiter_unavailable" })
		const empty = fake(() => ({ status: 200, body: { swapTransaction: "not base64!" } }))
		const r = new JupiterClient({ fetch: empty.fetch })
		await expect(r.swapTransaction({ quote, userPublicKey: WALLET })).rejects.toMatchObject({
			code: "bad_response",
		})
		const noHeight = fake(() => ({ status: 200, body: { swapTransaction: "AQID" } }))
		await expect(
			new JupiterClient({ fetch: noHeight.fetch }).swapTransaction({ quote, userPublicKey: WALLET }),
		).resolves.toEqual({ transaction: "AQID", lastValidBlockHeight: null })
		await expect(r.swapTransaction({ quote, userPublicKey: "bad" })).rejects.toMatchObject({
			code: "bad_response",
		})
	})
})
