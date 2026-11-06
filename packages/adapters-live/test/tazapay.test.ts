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
	currencies: ["PHP"],
	endpointTypes: ["bank_account"],
	legKinds: ["payout"],
	fee: { fixed: { amount: "0", currency: "PHP" }, bps: 0 },
	fxSpreadBps: 0,
	estimatedTimeSeconds: 600,
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

function fakeApi(
	opts: { payoutStatus?: string; metadataFails?: boolean } = {},
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
		if (path === "/v3/payout/quote")
			return reply(200, {
				id: "poq_1",
				object: "payout_quote",
				payout_type: "local",
				holding_info: { currency: "PHP", amount: 10000 },
				payout_info: { currency: "PHP", amount: 10000 },
				destination_info: { currency: "PHP", amount: 10000 },
				fee_info: {
					fixed: { in_holding_currency: 100, in_payout_currency: 100 },
					variable: { in_holding_currency: 50, in_payout_currency: 50 },
				},
				exchange_rates: { holding_to_payout: 1, payout_to_destination: 1 },
				status: "active",
			})
		if (path === "/v3/metadata/payout/bank") {
			if (opts.metadataFails)
				return reply(500, { status: "error", message: "unavailable" })
			return reply(200, {
				status: "success",
				data: {
					payout_methods: [
						{
							country: "PH",
							currency: "PHP",
							payout_type: "local",
							fund_transfer_networks: [
								{ name: "instapay", delivery_time: "instant" },
							],
						},
					],
				},
			})
		}
		if (path === "/v3/payout" && init.method === "POST")
			return reply(200, {
				status: "success",
				data: { id: "pot_1", object: "payout", status: "processing" },
			})
		if (path === "/v3/payout/pot_1")
			return reply(200, {
				status: "success",
				data: {
					id: "pot_1",
					object: "payout",
					status: opts.payoutStatus ?? "succeeded",
					status_description: "",
					failure: null,
				},
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

const leg = (amountIn = money("9850", "PHP")) => ({
	kind: "payout" as const,
	amountIn,
	outCurrency: amountIn.currency,
	endpoint: {
		endpointId: "ep_1",
		type: "bank_account" as const,
		country: "PH",
		currency: "PHP",
	},
	paymentId: "pay_1",
	legId: "leg_payout",
	attempt: 1,
})

describe("Tazapay adapter", () => {
	it("prices a payout from Tazapay's own quote, in the payout currency", async () => {
		const api = fakeApi()
		const q = await adapter(api).quote({
			kind: "payout",
			amountIn: money("10000", "PHP"),
			outCurrency: "PHP",
			endpoint: {
				endpointId: "ep_1",
				type: "bank_account",
				country: "PH",
				currency: "PHP",
			},
		})
		expect(api.calls[0]!.path).toBe("/v3/payout/quote")
		expect(api.calls[0]!.headers.Authorization).toBe(
			`Basic ${Buffer.from("tz_key:tz_secret").toString("base64")}`,
		)
		expect(api.calls[0]!.body).toEqual({
			payout_type: "local",
			holding_info: { currency: "PHP" },
			payout_info: { amount: 10000, currency: "PHP" },
			destination_info: { currency: "PHP", country: "PH" },
		})
		expect(q.fee).toEqual(money("150", "PHP"))
		expect(q.amountOut).toEqual(money("9850", "PHP"))
		expect(q.fxRate).toBeNull()
		expect(q.simulated).toBe(true)
	})

	it("refuses a fee at or above the payout amount", async () => {
		const api = fakeApi()
		const a = adapter(api)
		// A 0.01 PHP payout cannot cover the fake 1.50 PHP fee.
		await expect(
			a.quote({ kind: "payout", amountIn: money("1", "PHP"), outCurrency: "PHP" }),
		).rejects.toMatchObject({ code: "fee_exceeds_amount" })
	})

	it("refuses a convert leg and a currency it does not pay", async () => {
		await expect(
			adapter().quote({
				kind: "convert",
				amountIn: money("10000", "PHP"),
				outCurrency: "PHP",
			}),
		).rejects.toMatchObject({ code: "unsupported" })
		await expect(
			adapter().quote({
				kind: "payout",
				amountIn: money("10000", "USD"),
				outCurrency: "PHP",
			}),
		).rejects.toMatchObject({ code: "currency_mismatch" })
		await expect(
			adapter().quote({
				kind: "payout",
				amountIn: money("10000", "BRL"),
				outCurrency: "BRL",
			}),
		).rejects.toMatchObject({ code: "unsupported" })
	})

	it("creates the payout once per (legId, attempt), with Basic auth and an idempotency key", async () => {
		const api = fakeApi()
		const a = adapter(api)
		const first = await a.execute(leg())
		expect(first.externalRef).toBe("pot_1")
		const quote = api.calls.find((c) => c.path === "/v3/payout/quote")!
		expect(quote.body).toMatchObject({
			payout_info: { amount: 9850, currency: "PHP" },
		})
		const payout = api.calls.find((c) => c.path === "/v3/payout")!
		expect(payout.body).toMatchObject({
			amount: 9850,
			currency: "PHP",
			holding_currency: "PHP",
			type: "local",
			purpose: "PYR001",
			beneficiary: "bnf_1",
			quote: "poq_1",
			reference_id: "flexipay-leg_payout:1",
			local: { fund_transfer_network: "instapay" },
		})
		expect(payout.headers["Idempotency-Key"]).toBe("flexipay-leg_payout:1")

		const before = api.calls.length
		expect((await a.execute(leg())).externalRef).toBe("pot_1")
		expect(api.calls.length).toBe(before)
	})

	it("refuses a payout when no Tazapay beneficiary is configured", async () => {
		await expect(
			adapter(fakeApi(), { beneficiary: null }).execute(leg()),
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
			const state = await adapter(
				fakeApi({ payoutStatus: raw }),
			).status("pot_1")
			expect(state.status).toBe(expected)
			if (expected === "failed")
				expect(state.error?.code).toBe("provider_down")
		}
		expect(
			(await adapter(fakeApi({ payoutStatus: "new_state" })).status("pot_1"))
				.status,
		).toBe("processing")
		await expect(adapter().status("pot_missing")).rejects.toMatchObject({
			code: "unknown_reference",
		})
	})

	it("a payout cannot be reversed", async () => {
		await expect(adapter().reverse("pot_1")).rejects.toMatchObject({
			code: "not_reversible",
		})
		await expect(adapter().reverse("pot_1")).rejects.toBeInstanceOf(
			ProviderError,
		)
	})

	it("health is a cached read-only metadata call", async () => {
		const api = fakeApi()
		const a = adapter(api)
		expect(await a.health()).toBe("up")
		expect(await a.health()).toBe("up")
		expect(api.calls.filter((c) => c.path === "/v3/metadata/payout/bank"))
			.toHaveLength(1)
		expect(api.calls[0]!.search).toBe("?country=PH&currency=PHP")
		expect(await adapter(fakeApi({ metadataFails: true })).health()).toBe(
			"down",
		)
	})

	it("refuses the production base URL without written approval", async () => {
		const a = adapter(fakeApi(), {
			baseUrl: "https://service.tazapay.com",
		})
		await expect(
			a.quote({
				kind: "payout",
				amountIn: money("10000", "PHP"),
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
		expect(createLiveProviders(config, {}).skipped).toEqual([
			"tazapay_sandbox",
		])
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
