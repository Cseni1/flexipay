import { describe, expect, it } from "vitest"
import {
	ProviderError,
	money,
	type FlexiPayConfig,
	type Provider,
} from "@flexipay/domain"
import {
	TazapayAdapter,
	createLiveProviders,
	type FetchLike,
} from "../src/index.ts"

// Tazapay adapter against a fake of the documented Tazapay API (no network, no keys).

const ROW: Provider = {
	id: "tazapay_sandbox",
	kind: "bank",
	countries: ["PH"],
	currencies: ["GBP", "TGBP", "USD", "USDC", "PHP"],
	endpointTypes: ["bank_account"],
	legKinds: ["convert", "payout"],
	fee: { fixed: { amount: "0", currency: "GBP" }, bps: 0 },
	fxSpreadBps: 0,
	estimatedTimeSeconds: 300,
	limits: null,
	simulated: true,
	placeholder: false,
	implementation: "tazapay",
}

type Call = {
	method: string
	path: string
	search: string
	body: unknown
	headers: Record<string, string>
}

// Response shapes copied from the Tazapay sandbox on 6 Nov 2026 (every success wraps `data`).
function fakeApi(
	opts: {
		payoutStatus?: string
		metadataFails?: boolean
		payoutAmount?: number
	} = {},
) {
	const calls: Call[] = []
	const fetch: FetchLike = async (url, init) => {
		const parsed = new URL(url)
		const path = parsed.pathname
		const body = init.body ? JSON.parse(init.body) : undefined
		calls.push({
			method: init.method,
			path,
			search: parsed.search,
			body,
			headers: init.headers,
		})
		const reply = (status: number, json: unknown) => ({
			status,
			text: async () => JSON.stringify(json),
		})
		const ok = (data: unknown) =>
			reply(200, { status: "success", message: "", data })
		if (path === "/v3/payout/quote") {
			const hold = (
				body as { holding_info: { currency: string; amount: number } }
			).holding_info
			return ok({
				id: "poq_1",
				object: "payout_quote",
				status: "expired",
				payout_type: "local",
				holding_info: hold,
				// GBP 100.00 held -> PHP 7853.81 after the 4.08 GBP fee at 81.8779 (sandbox figures).
				payout_info: { currency: "PHP", amount: opts.payoutAmount ?? 785381 },
				destination_info: {
					currency: "PHP",
					amount: opts.payoutAmount ?? 785381,
					country: "PH",
				},
				fee_info: {
					fixed: { in_holding_currency: 408, in_payout_currency: 33398 },
					variable: { in_holding_currency: 0, in_payout_currency: 0 },
				},
				exchange_rates: {
					holding_to_payout: 81.87789419798463,
					payout_to_destination: 1,
				},
			})
		}
		if (path === "/v3/metadata/payout/bank") {
			if (opts.metadataFails)
				return reply(500, { status: "error", message: "unavailable" })
			return ok({
				payout_methods: [
					{
						country: "PH",
						currency: "PHP",
						payout_type: "local",
						fund_transfer_networks: [{ name: "instapay" }, { name: "pesonet" }],
					},
				],
			})
		}
		if (path === "/v3/payout" && init.method === "POST")
			return ok({ id: "pot_1", object: "payout", status: "processing" })
		if (path === "/v3/payout/pot_1")
			return ok({
				id: "pot_1",
				object: "payout",
				status: opts.payoutStatus ?? "succeeded",
				status_description: "",
				failure: null,
			})
		if (path.startsWith("/v3/payout/"))
			return reply(404, { status: "error", message: "Resource not found" })
		return reply(500, { status: "error", message: "unexpected" })
	}
	return { calls, fetch }
}

function adapter(
	api = fakeApi(),
	extra: Partial<{
		baseUrl: string
		liveApproved: boolean
		beneficiary: string | null
	}> = {},
) {
	return new TazapayAdapter(ROW, {
		apiKey: "tz_key",
		apiSecret: "tz_secret",
		sandboxBeneficiaryId:
			extra.beneficiary === undefined ? "bnf_1" : extra.beneficiary,
		liveApproved: extra.liveApproved ?? false,
		baseUrl: extra.baseUrl,
		fetch: api.fetch,
	})
}

const PH_BANK = {
	endpointId: "ep_1",
	type: "bank_account" as const,
	country: "PH",
	currency: "PHP",
}

const leg = (
	kind: "convert" | "payout",
	amountIn = money("785381", "PHP"),
	paymentId = "pay_1",
) => ({
	kind,
	amountIn,
	outCurrency: "PHP",
	endpoint: PH_BANK,
	paymentId,
	legId: `leg_${kind}`,
	attempt: 1,
})

describe("Tazapay adapter", () => {
	it("prices convert from the payout quote for the held amount (tGBP -> GBP balance -> PHP)", async () => {
		const api = fakeApi()
		// 100 tGBP at 7 domain decimals.
		const q = await adapter(api).quote({
			kind: "convert",
			amountIn: money("1000000000", "TGBP"),
			outCurrency: "PHP",
			endpoint: PH_BANK,
		})
		expect(api.calls[0]!.path).toBe("/v3/payout/quote")
		expect(api.calls[0]!.headers.Authorization).toBe(
			`Basic ${Buffer.from("tz_key:tz_secret").toString("base64")}`,
		)
		expect(api.calls[0]!.body).toEqual({
			payout_type: "local",
			holding_info: { currency: "GBP", amount: 10000 },
			payout_info: { currency: "PHP" },
			destination_info: { currency: "PHP", country: "PH" },
		})
		expect(q.amountOut).toEqual(money("785381", "PHP"))
		expect(q.fee).toEqual(money("40800000", "TGBP"))
		expect(q.fxRate).toBe("81.8779")
		expect(q.simulated).toBe(true)
	})

	it("holds USD for a USDC input", async () => {
		const api = fakeApi()
		await adapter(api).quote({
			kind: "convert",
			amountIn: money("1000000000", "USDC"),
			outCurrency: "PHP",
			endpoint: PH_BANK,
		})
		expect(api.calls[0]!.body).toMatchObject({
			holding_info: { currency: "USD", amount: 10000 },
		})
	})

	it("payout is a pass-through in local currency", async () => {
		const q = await adapter().quote({
			kind: "payout",
			amountIn: money("785381", "PHP"),
			outCurrency: "PHP",
			endpoint: PH_BANK,
		})
		expect(q.fee).toEqual(money("0", "PHP"))
		expect(q.amountOut).toEqual(money("785381", "PHP"))
	})

	it("refuses inputs it cannot hold, currencies it does not pay and a zero result", async () => {
		await expect(
			adapter().quote({
				kind: "convert",
				amountIn: money("10000", "BRL"),
				outCurrency: "PHP",
			}),
		).rejects.toMatchObject({ code: "unsupported" })
		await expect(
			adapter().quote({
				kind: "convert",
				amountIn: money("10000", "GBP"),
				outCurrency: "BRL",
			}),
		).rejects.toMatchObject({ code: "unsupported" })
		await expect(
			adapter().quote({
				kind: "payout",
				amountIn: money("10000", "GBP"),
				outCurrency: "PHP",
			}),
		).rejects.toMatchObject({ code: "currency_mismatch" })
		await expect(
			adapter(fakeApi({ payoutAmount: 0 })).quote({
				kind: "convert",
				amountIn: money("100", "GBP"),
				outCurrency: "PHP",
			}),
		).rejects.toMatchObject({ code: "fee_exceeds_amount" })
	})

	it("convert is a record; payout pays from the convert's holding balance, once per (legId, attempt)", async () => {
		const api = fakeApi()
		const a = adapter(api)
		const conv = await a.execute(leg("convert", money("1000000000", "TGBP")))
		expect(conv.externalRef).toBe("tazapay-convert:GBP:leg_convert:1")
		expect(api.calls).toHaveLength(0)
		expect((await a.status(conv.externalRef)).status).toBe("succeeded")

		const first = await a.execute(leg("payout"))
		expect(first.externalRef).toBe("pot_1")
		const payout = api.calls.find((c) => c.path === "/v3/payout")!
		expect(payout.body).toEqual({
			amount: 785381,
			currency: "PHP",
			holding_currency: "GBP",
			type: "local",
			purpose: "PYR001",
			beneficiary: "bnf_1",
			reference_id: "flexipay-leg_payout:1",
			transaction_description: "FlexiPay payout",
		})
		expect(payout.headers["Idempotency-Key"]).toBe("flexipay-leg_payout:1")

		const before = api.calls.length
		expect((await a.execute(leg("payout"))).externalRef).toBe("pot_1")
		expect(api.calls.length).toBe(before)
	})

	it("falls back to USD holding when the convert step ran elsewhere", async () => {
		const api = fakeApi()
		await adapter(api).execute(
			leg("payout", money("785381", "PHP"), "pay_other"),
		)
		expect(api.calls.find((c) => c.path === "/v3/payout")!.body).toMatchObject({
			holding_currency: "USD",
		})
	})

	it("refuses a payout when no Tazapay beneficiary is configured", async () => {
		await expect(
			adapter(fakeApi(), { beneficiary: null }).execute(leg("payout")),
		).rejects.toMatchObject({ code: "unsupported" })
	})

	it("maps every Tazapay payout state", async () => {
		const statuses: Array<[string, string]> = [
			["succeeded", "succeeded"],
			["processing", "processing"],
			["requires_funding", "processing"],
			["requires_confirmation", "processing"],
			["requires_action", "processing"],
			["requires_approval", "processing"],
			["approval_hold", "processing"],
			["initiator_bank_hold", "processing"],
			["compliance_hold", "processing"],
			["failed", "failed"],
			["cancelled", "failed"],
			["reversed", "failed"],
		]
		for (const [raw, expected] of statuses) {
			const state = await adapter(fakeApi({ payoutStatus: raw })).status(
				"pot_1",
			)
			expect(state.status).toBe(expected)
			if (expected === "failed") expect(state.error?.code).toBe("provider_down")
		}
		expect(
			(await adapter(fakeApi({ payoutStatus: "new_state" })).status("pot_1"))
				.status,
		).toBe("processing")
		await expect(adapter().status("pot_missing")).rejects.toMatchObject({
			code: "unknown_reference",
		})
	})

	it("the convert record reverses; a payout cannot be reversed", async () => {
		expect(
			(await adapter().reverse("tazapay-convert:GBP:leg_convert:1"))
				.externalRef,
		).toContain("reversed")
		await expect(adapter().reverse("pot_1")).rejects.toMatchObject({
			code: "not_reversible",
		})
		await expect(adapter().reverse("pot_1")).rejects.toBeInstanceOf(
			ProviderError,
		)
	})

	it("health is a cached read-only metadata call for the payout currency", async () => {
		const api = fakeApi()
		const a = adapter(api)
		expect(await a.health()).toBe("up")
		expect(await a.health()).toBe("up")
		expect(
			api.calls.filter((c) => c.path === "/v3/metadata/payout/bank"),
		).toHaveLength(1)
		expect(api.calls[0]!.search).toBe("?country=PH&currency=PHP")
		expect(await adapter(fakeApi({ metadataFails: true })).health()).toBe(
			"down",
		)
	})

	it("surfaces Tazapay's own error message", async () => {
		const fetch: FetchLike = async () => ({
			status: 400,
			text: async () =>
				JSON.stringify({
					status: "error",
					message: "Bad Request : Your request is invalid",
					errors: [
						{
							code: 20199,
							message: "There is insufficient balance in your account",
						},
					],
				}),
		})
		await expect(
			new TazapayAdapter(ROW, {
				apiKey: "k",
				apiSecret: "s",
				sandboxBeneficiaryId: "bnf_1",
				liveApproved: false,
				fetch,
			}).execute(leg("payout")),
		).rejects.toThrow(/insufficient balance/)
	})

	it("refuses the production base URL without written approval", async () => {
		const a = adapter(fakeApi(), { baseUrl: "https://service.tazapay.com" })
		await expect(
			a.quote({
				kind: "convert",
				amountIn: money("10000", "GBP"),
				outCurrency: "PHP",
			}),
		).rejects.toMatchObject({ code: "unsupported" })
		expect(await a.health()).toBe("down")
		const approved = adapter(fakeApi(), {
			baseUrl: "https://service.tazapay.com",
			liveApproved: true,
		})
		expect(await approved.health()).toBe("up")
	})
})

describe("createLiveProviders (Tazapay)", () => {
	const config = { providers: [ROW] } as unknown as FlexiPayConfig

	it("registers Tazapay only when both keys are set", () => {
		expect(createLiveProviders(config, {}).providers.size).toBe(0)
		expect(createLiveProviders(config, {}).skipped).toEqual(["tazapay_sandbox"])
		expect(
			createLiveProviders(config, { TAZAPAY_API_KEY: "k" }).providers.size,
		).toBe(0)
		const live = createLiveProviders(config, {
			TAZAPAY_API_KEY: "k",
			TAZAPAY_API_SECRET: "s",
		})
		expect([...live.providers.keys()]).toEqual(["tazapay_sandbox"])
	})
})
