import { describe, expect, it } from "vitest"
import {
	ProviderError,
	money,
	type FlexiPayConfig,
	type Provider,
} from "@flexipay/domain"
import {
	BlindPayAdapter,
	createLiveProviders,
	type FetchLike,
} from "../src/index.ts"

// BlindPay adapter against a recorded-shape fake of the BlindPay API (no network).

const ROW: Provider = {
	id: "blindpay_sandbox",
	kind: "bank",
	countries: ["BR", "MX", "CO", "AR"],
	currencies: ["USDC", "BRL", "MXN", "COP", "ARS"],
	endpointTypes: ["bank_account"],
	legKinds: ["convert", "payout"],
	fee: { fixed: { amount: "0", currency: "USDC" }, bps: 0 },
	fxSpreadBps: 0,
	estimatedTimeSeconds: 600,
	limits: null,
	simulated: true,
	placeholder: false,
	implementation: "blindpay",
}

const SANDBOX = { customerId: "cu_1", bankAccountId: "ba_1", walletId: "wa_1" }

type Call = {
	method: string
	path: string
	body: unknown
	headers: Record<string, string>
}

function fakeApi(opts: { instanceType?: string; payoutStatus?: string } = {}) {
	const calls: Call[] = []
	const fetch: FetchLike = async (url, init) => {
		const path = new URL(url).pathname
		const body = init.body ? JSON.parse(init.body) : undefined
		calls.push({ method: init.method, path, body, headers: init.headers })
		const reply = (status: number, json: unknown) => ({
			status,
			text: async () => JSON.stringify(json),
		})
		if (path === "/v1/instances/in_1")
			return reply(200, {
				id: "in_1",
				type: opts.instanceType ?? "development",
			})
		if (path === "/v1/instances/in_1/quotes/fx")
			return reply(200, {
				result_amount: 54891,
				blindpay_quotation: 549.46,
				commercial_quotation: 550.01,
			})
		if (path === "/v1/instances/in_1/quotes")
			return reply(200, {
				id: "qu_1",
				sender_amount: 1000,
				receiver_amount: 5443,
			})
		if (path === "/v1/instances/in_1/customers/cu_1/wallets/wa_1")
			return reply(200, { id: "wa_1", address: "So1anaAddr" })
		if (path === "/v1/instances/in_1/mint-usdb-solana")
			return reply(200, { success: true })
		if (path === "/v1/instances/in_1/payouts/evm")
			return reply(200, { id: "pa_1", status: "processing" })
		if (path === "/v1/instances/in_1/payouts/pa_1")
			return reply(200, {
				id: "pa_1",
				status: opts.payoutStatus ?? "completed",
			})
		if (path.startsWith("/v1/instances/in_1/payouts/"))
			return reply(404, { message: "not found" })
		return reply(500, { message: "unexpected" })
	}
	return { calls, fetch }
}

function adapter(
	api = fakeApi(),
	extra: Partial<{
		sandbox: typeof SANDBOX | null
		liveApproved: boolean
	}> = {},
) {
	return new BlindPayAdapter(ROW, {
		apiKey: "bp_test_key",
		instanceId: "in_1",
		sandbox: extra.sandbox === undefined ? SANDBOX : extra.sandbox,
		liveApproved: extra.liveApproved ?? false,
		fetch: api.fetch,
	})
}

const leg = (kind: "convert" | "payout", amountIn = money("5443", "BRL")) => ({
	kind,
	amountIn,
	outCurrency: amountIn.currency,
	paymentId: "pay_1",
	legId: `leg_${kind}`,
	attempt: 1,
})

describe("BlindPay adapter", () => {
	it("prices convert from BlindPay's own FX quote, fee in USDC", async () => {
		const api = fakeApi()
		const q = await adapter(api).quote({
			kind: "convert",
			amountIn: money("1000000000", "USDC"),
			outCurrency: "BRL",
		})
		expect(api.calls[0]!.body).toEqual({
			from: "USDC",
			to: "BRL",
			request_amount: 10000,
			currency_type: "sender",
		})
		expect(api.calls[0]!.headers.Authorization).toBe("Bearer bp_test_key")
		expect(q.amountOut).toEqual(money("54891", "BRL"))
		expect(q.fxRate).toBe("5.4946")
		// 548.91 BRL at 5.4946 is 99.8999017 USDC delivered (rounded down), so the fee is 0.1000983 USDC.
		expect(q.fee).toEqual(money("1000983", "USDC"))
		expect(q.simulated).toBe(true)
	})

	it("refuses amounts under BlindPay's 5.00 minimum", async () => {
		await expect(
			adapter().quote({
				kind: "convert",
				amountIn: money("40000000", "USDC"),
				outCurrency: "BRL",
			}),
		).rejects.toMatchObject({ code: "below_min" })
	})

	it("refuses to convert anything but USDC", async () => {
		await expect(
			adapter().quote({
				kind: "convert",
				amountIn: money("10000", "USD"),
				outCurrency: "BRL",
			}),
		).rejects.toBeInstanceOf(ProviderError)
	})

	it("payout quote passes the converted amount through with no extra fee", async () => {
		const q = await adapter().quote({
			kind: "payout",
			amountIn: money("5443", "BRL"),
			outCurrency: "BRL",
		})
		expect(q.amountOut).toEqual(money("5443", "BRL"))
		expect(q.fee).toEqual(money("0", "BRL"))
	})

	it("convert executes as a record and succeeds at once; idempotent", async () => {
		const a = adapter()
		const first = await a.execute(leg("convert", money("1000000000", "USDC")))
		const again = await a.execute(leg("convert", money("1000000000", "USDC")))
		expect(again.externalRef).toBe(first.externalRef)
		expect((await a.status(first.externalRef)).status).toBe("succeeded")
	})

	it("payout on a development instance quotes the exact local amount, tops up test tokens, pays", async () => {
		const api = fakeApi()
		const a = adapter(api)
		const { externalRef } = await a.execute(leg("payout"))
		expect(externalRef).toBe("pa_1")
		const quote = api.calls.find((c) => c.path.endsWith("/quotes"))!
		expect(quote.body).toMatchObject({
			bank_account_id: "ba_1",
			network: "solana_devnet",
			token: "USDB",
			currency_type: "receiver",
			request_amount: 5443,
		})
		expect(api.calls.some((c) => c.path.endsWith("/mint-usdb-solana"))).toBe(
			true,
		)
		const payout = api.calls.find((c) => c.path.endsWith("/payouts/evm"))!
		expect(payout.body).toEqual({ quote_id: "qu_1", wallet_id: "wa_1" })
		expect(payout.headers["Idempotency-Key"]).toBe("flexipay-leg_payout:1")
		// Replay returns the same payout without calling BlindPay again.
		const before = api.calls.length
		expect((await a.execute(leg("payout"))).externalRef).toBe("pa_1")
		expect(api.calls.length).toBe(before)
	})

	it("maps BlindPay payout statuses", async () => {
		expect(
			(await adapter(fakeApi({ payoutStatus: "completed" })).status("pa_1"))
				.status,
		).toBe("succeeded")
		expect(
			(await adapter(fakeApi({ payoutStatus: "processing" })).status("pa_1"))
				.status,
		).toBe("processing")
		expect(
			(await adapter(fakeApi({ payoutStatus: "on_hold" })).status("pa_1"))
				.status,
		).toBe("processing")
		const failed = await adapter(fakeApi({ payoutStatus: "refunded" })).status(
			"pa_1",
		)
		expect(failed.status).toBe("failed")
		expect(failed.error?.code).toBe("provider_down")
		await expect(adapter().status("pa_unknown")).rejects.toMatchObject({
			code: "unknown_reference",
		})
	})

	it("never moves real money without written approval", async () => {
		const a = adapter(fakeApi({ instanceType: "production" }))
		await expect(a.execute(leg("payout"))).rejects.toMatchObject({
			code: "unsupported",
		})
		expect(await a.health()).toBe("down")
	})

	it("refuses a payout when no BlindPay recipient account is configured", async () => {
		await expect(
			adapter(fakeApi(), { sandbox: null }).execute(leg("payout")),
		).rejects.toMatchObject({
			code: "unsupported",
		})
	})

	it("a payout cannot be reversed; the convert record can", async () => {
		const a = adapter()
		await expect(a.reverse("pa_1")).rejects.toMatchObject({
			code: "not_reversible",
		})
		expect(
			(await a.reverse("blindpay-convert:leg_convert:1")).externalRef,
		).toContain("reversed")
	})

	it("health is up on a development instance", async () => {
		expect(await adapter().health()).toBe("up")
	})
})

describe("createLiveProviders", () => {
	const config = { providers: [ROW] } as unknown as FlexiPayConfig

	it("registers BlindPay only when its keys are set", () => {
		expect(createLiveProviders(config, {}).providers.size).toBe(0)
		expect(createLiveProviders(config, {}).skipped).toEqual([
			"blindpay_sandbox",
		])
		const live = createLiveProviders(config, {
			BLINDPAY_API_KEY: "k",
			BLINDPAY_INSTANCE_ID: "in_1",
		})
		expect([...live.providers.keys()]).toEqual(["blindpay_sandbox"])
	})
})
