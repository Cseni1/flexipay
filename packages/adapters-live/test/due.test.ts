import { describe, expect, it } from "vitest"
import {
	ProviderError,
	money,
	type EndpointRef,
	type FlexiPayConfig,
	type Provider,
} from "@flexipay/domain"
import {
	DUE_PRODUCTION_BASE_URL,
	DueAdapter,
	createLiveProviders,
	type FetchLike,
} from "../src/index.ts"
import {
	DUE_FUNDING_GRACE_MS,
	addressText,
	decimalToMinor,
	minorToDecimal,
} from "../src/due.ts"

// Due adapter against a fake of the documented Due API (no network, no keys). Response shapes are
// copied from the Due sandbox on 9 Nov 2026 (GET /v1/channels, GET /v1/schemas, quotes, errors).

const ROW: Provider = {
	id: "due_sandbox",
	kind: "bank",
	countries: ["BR", "MX", "CO", "IN", "NG", "PH"],
	currencies: ["USDC", "TGBP", "BRL", "MXN", "COP", "INR", "NGN", "PHP"],
	endpointTypes: ["bank_account"],
	legKinds: ["convert", "payout"],
	fee: { fixed: { amount: "0", currency: "USDC" }, bps: 0 },
	fxSpreadBps: 0,
	estimatedTimeSeconds: 300,
	limits: null,
	simulated: true,
	placeholder: false,
	implementation: "due",
}

const ANY_PURPOSE = ["PERSONAL_TRANSFER", "OTHER"]

const CHANNELS = [
	{
		rail: "brl_pix",
		railSettings: {
			rail: "brl_pix",
			speed: "5 minutes",
			memoConfig: null,
			schemas: ["bank_br_pix"],
		},
		currencyCode: "BRL",
		feeBps: 30,
		feeFixed: "0",
		type: "withdrawal",
		purposeCodes: {},
	},
	{
		rail: "brl_pix",
		railSettings: { schemas: ["bank_br_pix"] },
		currencyCode: "BRL",
		type: "deposit",
	},
	{
		rail: "brl_local",
		railSettings: { schemas: ["bank_br"] },
		currencyCode: "BRL",
		type: "withdrawal",
	},
	{
		rail: "spei",
		railSettings: {
			memoConfig: { minCharacters: 0, maxCharacters: 40, required: false },
			schemas: ["bank_mexico"],
		},
		currencyCode: "MXN",
		type: "withdrawal",
		purposeCodes: {},
	},
	{
		rail: "cop_local",
		railSettings: {
			memoConfig: { minCharacters: 1, maxCharacters: 6, required: false },
			schemas: ["bank_colombia"],
		},
		currencyCode: "COP",
		type: "withdrawal",
		purposeCodes: { any: ANY_PURPOSE },
	},
	{
		rail: "inr_upi",
		railSettings: {
			memoConfig: { minCharacters: 10, maxCharacters: 20 },
			schemas: ["bank_in_upi"],
		},
		currencyCode: "INR",
		type: "withdrawal",
		purposeCodes: { individual: ["FAMILY_SUPPORT", "EDUCATION"] },
	},
	{
		rail: "swift",
		railSettings: { schemas: ["bank_swift"] },
		currencyCode: "PHP",
		type: "withdrawal",
	},
	{
		rail: "php_ewallet",
		railSettings: { schemas: ["ewallet_ph"] },
		currencyCode: "PHP",
		type: "withdrawal",
	},
	{
		rail: "php_local",
		railSettings: { schemas: ["bank_ph"] },
		currencyCode: "PHP",
		type: "withdrawal",
	},
	{ rail: "broken", currencyCode: "NGN", type: "withdrawal" },
	{
		rail: "ngn_local",
		railSettings: { schemas: ["bank_africa"] },
		currencyCode: "NGN",
		type: "withdrawal",
	},
	"not a channel",
]

const NAME_FIELDS = [
	{
		key: "accountType",
		type: "string",
		oneOf: ["individual", "business"],
		required: true,
	},
	{
		key: "firstName",
		type: "string",
		requiredIf: "accountType=individual",
		excludedUnless: "accountType=individual",
	},
	{
		key: "lastName",
		type: "string",
		requiredIf: "accountType=individual",
		excludedUnless: "accountType=individual",
	},
	{
		key: "companyName",
		type: "string",
		requiredIf: "accountType=business",
		excludedUnless: "accountType=business",
	},
]

const SCHEMAS = [
	{
		id: "bank_br_pix",
		category: "bank",
		fields: [{ key: "pixKey", type: "pixKey", required: true }],
	},
	{
		id: "bank_mexico",
		category: "bank",
		fields: [
			{ key: "clabe", type: "clabe", required: true },
			{ key: "beneficiaryName", type: "string", required: true },
			{ key: "email", type: "email" },
		],
	},
	{
		id: "bank_colombia",
		category: "bank",
		fields: [
			...NAME_FIELDS,
			{
				key: "financialInstitutionId",
				type: "financial_institution",
				required: true,
			},
			{
				key: "bankAccountType",
				type: "string",
				oneOf: ["cc", "ch", "dp"],
				required: true,
			},
			{ key: "accountNumber", type: "numeric", required: true },
			{
				key: "idType",
				type: "string",
				oneOf: ["cc", "ce", "pa", "ppt", "ti"],
				requiredIf: "accountType=individual",
				excludedUnless: "accountType=individual",
			},
			{ key: "idNumber", type: "colombia_id_number", required: true },
		],
	},
	{
		id: "bank_in_upi",
		category: "bank",
		fields: [
			...NAME_FIELDS,
			{ key: "accountNumber", type: "string", required: true },
		],
	},
	{
		id: "bank_ph",
		category: "bank",
		fields: [
			{ key: "beneficiaryName", type: "string", required: true },
			{
				key: "financialInstitutionId",
				type: "financial_institution",
				required: true,
			},
			{ key: "accountNumber", type: "string", required: true },
			{ key: "branchCode", type: "string", required: true },
			{
				key: "beneficiaryAddress",
				type: "object",
				required: true,
				fields: [
					{ key: "street_line_1", type: "swift_x", required: true },
					{ key: "city", type: "swift_x", required: true },
					{ key: "zone", type: "string", required: true },
					{ key: "street_line_2", type: "swift_x" },
				],
			},
		],
	},
	{ bad: true },
	{ id: "bank_odd", fields: "nope" },
]

/** USDC per 1 unit of each payout currency (Due's fxRate direction). */
const DUE_RATE: Record<string, number> = {
	BRL: 0.1824996770482083,
	MXN: 0.054050594588792994,
	COP: 0.00031138552687232963,
	INR: 0.010695669449614661,
	PHP: 0.01587179658620508,
}

type Call = {
	method: string
	path: string
	body: any
	headers: Record<string, string>
}

function fakeApi(
	opts: {
		transferStatus?: string
		channelsFail?: boolean
		channelsEmpty?: boolean
		schemasFail?: boolean
		quoteError?: { status: number; code: string; message: string }
		quoteServerError?: boolean
		quoteNoToken?: boolean
		quoteBadBody?: boolean
		quoteZero?: boolean
		transferNoId?: boolean
		recipientNoId?: boolean
		transferMissing?: boolean
		recipientsListFails?: boolean
		channelsObject?: boolean
		wallets?: unknown
		walletsFail?: boolean
		walletNoId?: boolean
		fundingBytes?: number[]
		expiresAt?: string
	} = {},
) {
	const calls: Call[] = []
	let transfers = 0
	let recipients = 0
	const fetch: FetchLike = async (url, init) => {
		const parsed = new URL(url)
		const path = parsed.pathname
		const body = init.body ? JSON.parse(init.body) : undefined
		calls.push({ method: init.method, path, body, headers: init.headers })
		const reply = (status: number, json: unknown) => ({
			status,
			text: async () => (json === undefined ? "" : JSON.stringify(json)),
		})
		const fail = (status: number, code: string, message: string) =>
			reply(status, {
				success: false,
				message,
				httpCode: status,
				code,
				dueCode: code,
			})
		if (path === "/v1/channels" && init.method === "GET") {
			if (opts.channelsFail) return reply(503, undefined)
			if (opts.channelsEmpty) return reply(200, [])
			return reply(200, opts.channelsObject ? { channels: CHANNELS } : CHANNELS)
		}
		if (path === "/v1/schemas" && init.method === "GET") {
			if (opts.schemasFail) return fail(500, "err_internal", "boom")
			return reply(200, SCHEMAS)
		}
		if (path === "/v1/transfers/quote" && init.method === "POST") {
			if (opts.quoteError)
				return fail(
					opts.quoteError.status,
					opts.quoteError.code,
					opts.quoteError.message,
				)
			if (opts.quoteServerError) return reply(502, { message: "upstream" })
			if (opts.quoteBadBody) return reply(200, { source: {}, destination: {} })
			const rate = DUE_RATE[body.destination.currency] ?? 1
			const isUsdc = body.source.currency === "USDC"
			const srcFee = isUsdc ? 0.3 : 1.2
			const token = opts.quoteNoToken ? {} : { token: "jwt.quote.token" }
			if (body.source.amount !== "0") {
				const src = Number(body.source.amount)
				const dst = opts.quoteZero ? 0 : (src - srcFee) / rate
				return reply(200, {
					source: {
						...body.source,
						fee: String(srcFee),
						totalFee: String(srcFee),
					},
					destination: {
						...body.destination,
						amount: dst.toFixed(2),
						fee: "1.65",
					},
					fxRate: rate,
					fxMarkup: 50,
					...token,
				})
			}
			const dst = Number(body.destination.amount)
			return reply(200, {
				source: {
					...body.source,
					amount: (dst * rate + srcFee).toFixed(6),
					fee: String(srcFee),
				},
				destination: { ...body.destination, fee: "1.65" },
				fxRate: rate,
				...token,
			})
		}
		if (path === "/v1/recipients" && init.method === "GET") {
			if (opts.recipientsListFails) return fail(500, "err_internal", "boom")
			return reply(200, {
				items: [
					"junk",
					{
						id: "rcp_gone",
						details: { schema: "bank_br_pix", pixKey: "taken" },
						isActive: false,
					},
					{
						id: "rcp_existing",
						details: { schema: "bank_br_pix", pixKey: "taken" },
						isActive: true,
					},
				],
				next: "",
			})
		}
		if (path === "/v1/recipients" && init.method === "POST") {
			recipients += 1
			if (opts.recipientNoId) return reply(200, {})
			if (String(body.details.pixKey).startsWith("taken")) {
				return fail(
					409,
					"err_recipient_already_exists",
					"Recipient already exists",
				)
			}
			return reply(200, {
				id: `rcp_${recipients}`,
				label: body.name,
				details: body.details,
				isExternal: true,
				isActive: true,
			})
		}
		if (path === "/v1/transfers" && init.method === "POST") {
			transfers += 1
			if (opts.transferNoId) return reply(200, { status: "awaiting_funds" })
			return reply(200, {
				id: `tfr_${transfers}`,
				status: "awaiting_funds",
				source: { amount: "91.525414", currency: "USDC", rail: "solana-local" },
				destination: { amount: "500", currency: "BRL", rail: "brl_pix" },
				transferInstructions: { kind: "TransferIntent" },
				expiresAt: "2026-11-09T14:00:00Z",
			})
		}
		const transfer = /^\/v1\/transfers\/([^/]+)$/.exec(path)
		if (transfer && init.method === "GET") {
			if (opts.transferMissing) return fail(404, "err_not_found", "Not found")
			const gbp = transfer[1] === "tfr_gbp"
			return reply(200, {
				id: transfer[1],
				status: opts.transferStatus ?? "awaiting_funds",
				source: gbp
					? { amount: "100", currency: "GBP", rail: "fp" }
					: { amount: "91.525414", currency: "USDC", rail: "solana-local" },
				transferInstructions: gbp
					? {
							kind: "details",
							details: {
								schema: "bank_uk",
								accountNumber: "12345678",
								sortCode: "000000",
							},
						}
					: { kind: "TransferIntent" },
				expiresAt: opts.expiresAt ?? "2026-11-09T14:00:00Z",
			})
		}
		const funding = /^\/v1\/transfers\/([^/]+)\/funding_address$/.exec(path)
		if (funding && init.method === "POST") {
			return reply(200, {
				details: {
					schema: "solana",
					address: opts.fundingBytes ?? "FundingAddr111",
				},
			})
		}
		if (path === "/v1/wallets" && init.method === "GET") {
			if (opts.walletsFail) return fail(500, "err_internal", "boom")
			return reply(
				200,
				opts.wallets ?? [
					{ id: "wlt_evm", address: "evm:0xabc" },
					"junk",
					{ id: "wlt_known", address: "solana:KnownWallet111" },
				],
			)
		}
		if (path === "/v1/wallets" && init.method === "POST") {
			if (opts.walletNoId) return reply(200, { address: body.address })
			if (!String(body.address).startsWith("solana:"))
				return fail(400, "err_invalid_address", "bad address")
			return reply(200, { id: "wlt_new", address: body.address })
		}
		return fail(404, "err_not_found", "Not found")
	}
	return { fetch, calls }
}

function adapter(
	api: ReturnType<typeof fakeApi>,
	extra: Partial<ConstructorParameters<typeof DueAdapter>[1]> = {},
	row: Provider = ROW,
) {
	let t = 1_000_000
	return new DueAdapter(row, {
		apiKey: "due_test_key",
		accountId: "acct_test",
		liveApproved: false,
		fetch: api.fetch,
		now: () => t,
		...extra,
		...(extra.now ? {} : { now: () => (t += 1) }),
	})
}

const PIX: EndpointRef = {
	endpointId: "ep_br",
	type: "bank_account",
	country: "BR",
	currency: "BRL",
	details: { accountNumber: "0001", pixKey: "tester@example.com" },
	recipientName: "Sandbox Tester",
	recipientKind: "individual",
}

const CO: EndpointRef = {
	endpointId: "ep_co",
	type: "bank_account",
	country: "CO",
	currency: "COP",
	details: {
		accountNumber: "123456789",
		bankCode: "co_bank_1",
		accountType: "Savings",
		documentType: "CC",
		documentId: "1234567890",
	},
	recipientName: "Ana Maria Test",
	recipientKind: "individual",
}

const legBase = {
	paymentId: "pay_1",
	legId: "leg_payout",
	attempt: 1,
}

describe("DueAdapter quote", () => {
	it("prices convert from Due's quote: amount, total fee and inverted rate", async () => {
		const api = fakeApi()
		const due = adapter(api)
		const q = await due.quote({
			kind: "convert",
			amountIn: money("1000000000", "USDC"), // 100 USDC (7 domain decimals)
			outCurrency: "BRL",
			endpoint: PIX,
		})
		const sent = api.calls.find((c) => c.path === "/v1/transfers/quote")!
		expect(sent.body).toEqual({
			source: { rail: "solana-local", currency: "USDC", amount: "100" },
			destination: { rail: "brl_pix", currency: "BRL", amount: "0" },
		})
		expect(sent.headers.Authorization).toBe("Bearer due_test_key")
		expect(sent.headers["Due-Account-Id"]).toBe("acct_test")
		expect(q.providerId).toBe("due_sandbox")
		expect(q.fee).toEqual(money("3000000", "USDC")) // 0.3 USDC
		expect(q.amountOut).toEqual(money("54630", "BRL"))
		expect(q.fxRate).toBe("5.4795")
		expect(q.simulated).toBe(true)
	})

	it("maps tGBP to a GBP Faster Payments source; the fee is in the input currency", async () => {
		const api = fakeApi()
		const due = adapter(api)
		const q = await due.quote({
			kind: "convert",
			amountIn: money("100000000", "TGBP"), // 10 tGBP, fee 1.2 GBP
			outCurrency: "MXN",
		})
		const sent = api.calls.find((c) => c.path === "/v1/transfers/quote")!
		expect(sent.body.source).toEqual({
			rail: "fp",
			currency: "GBP",
			amount: "10",
		})
		expect(sent.body.destination.rail).toBe("spei")
		expect(q.fee).toEqual(money("12000000", "TGBP"))
	})

	it("refuses amounts too small, unknown inputs and unsupported payout currencies", async () => {
		const due = adapter(fakeApi())
		await expect(
			due.quote({
				kind: "convert",
				amountIn: money("5", "USDC"),
				outCurrency: "BRL",
			}),
		).rejects.toMatchObject({ code: "below_min" })
		await expect(
			due.quote({
				kind: "convert",
				amountIn: money("100", "BRL"),
				outCurrency: "MXN",
			}),
		).rejects.toMatchObject({ code: "unsupported" })
		await expect(
			due.quote({
				kind: "convert",
				amountIn: money("100", "EUR"),
				outCurrency: "BRL",
			}),
		).rejects.toMatchObject({ code: "unsupported" })
		await expect(
			due.quote({
				kind: "convert",
				amountIn: money("1000000000", "USDC"),
				outCurrency: "EUR",
			}),
		).rejects.toMatchObject({ code: "unsupported" })
		await expect(
			due.quote({
				kind: "collect",
				amountIn: money("100", "BRL"),
				outCurrency: "BRL",
			}),
		).rejects.toMatchObject({ code: "unsupported" })
		const odd = adapter(
			fakeApi(),
			{},
			{ ...ROW, currencies: [...ROW.currencies, "USD"] },
		)
		await expect(
			odd.quote({
				kind: "convert",
				amountIn: money("10000", "USD"),
				outCurrency: "BRL",
			}),
		).rejects.toMatchObject({ code: "unsupported" })
	})

	it("payout quote passes the local amount through with no fee", async () => {
		const due = adapter(fakeApi())
		const q = await due.quote({
			kind: "payout",
			amountIn: money("50000", "BRL"),
			outCurrency: "BRL",
		})
		expect(q.amountOut).toEqual(money("50000", "BRL"))
		expect(q.fee).toEqual(money("0", "BRL"))
		expect(q.fxRate).toBeNull()
		await expect(
			due.quote({
				kind: "payout",
				amountIn: money("50000", "USDC"),
				outCurrency: "BRL",
			}),
		).rejects.toMatchObject({ code: "currency_mismatch" })
	})

	it("maps Due quote errors to provider error codes", async () => {
		const cases: Array<[number, string, string]> = [
			[400, "err_quote_limit_below_fee", "fee_exceeds_amount"],
			[400, "err_quote_limit_exceeded", "above_max"],
			[400, "err_channel_not_found", "unsupported"],
		]
		for (const [status, code, expected] of cases) {
			const due = adapter(
				fakeApi({ quoteError: { status, code, message: "no" } }),
			)
			const err = await due
				.quote({
					kind: "convert",
					amountIn: money("1000000000", "USDC"),
					outCurrency: "BRL",
				})
				.catch((e: unknown) => e)
			expect(err).toBeInstanceOf(ProviderError)
			expect((err as ProviderError).code).toBe(expected)
			expect((err as Error).message).toContain(code)
		}
		const down = adapter(fakeApi({ quoteServerError: true }))
		const err = await down
			.quote({
				kind: "convert",
				amountIn: money("1000000000", "USDC"),
				outCurrency: "BRL",
			})
			.catch((e: unknown) => e)
		expect(err).not.toBeInstanceOf(ProviderError)
		expect((err as Error).message).toMatch(/HTTP 502/)
	})

	it("rejects a quote without amounts, and one whose fee eats the amount", async () => {
		await expect(
			adapter(fakeApi({ quoteBadBody: true })).quote({
				kind: "convert",
				amountIn: money("1000000000", "USDC"),
				outCurrency: "BRL",
			}),
		).rejects.toThrow(/no amount, fee or rate/)
		await expect(
			adapter(fakeApi({ quoteZero: true })).quote({
				kind: "convert",
				amountIn: money("1000000000", "USDC"),
				outCurrency: "BRL",
			}),
		).rejects.toMatchObject({ code: "fee_exceeds_amount" })
	})

	it("needs a bank withdrawal channel for the currency", async () => {
		await expect(
			adapter(fakeApi({ channelsEmpty: true })).quote({
				kind: "convert",
				amountIn: money("1000000000", "USDC"),
				outCurrency: "NGN",
			}),
		).rejects.toMatchObject({ code: "unsupported" })
		await expect(
			adapter(fakeApi({ channelsFail: true })).quote({
				kind: "convert",
				amountIn: money("1000000000", "USDC"),
				outCurrency: "BRL",
			}),
		).rejects.toThrow(/channels failed \(HTTP 503/)
	})

	it("production is refused without written approval", async () => {
		const due = adapter(fakeApi(), { baseUrl: DUE_PRODUCTION_BASE_URL })
		expect(due.mode()).toBe("live")
		await expect(
			due.quote({
				kind: "payout",
				amountIn: money("100", "BRL"),
				outCurrency: "BRL",
			}),
		).rejects.toThrow(/not approved/)
		expect(await due.health()).toBe("down")
		const approved = adapter(fakeApi(), {
			baseUrl: DUE_PRODUCTION_BASE_URL,
			liveApproved: true,
		})
		await approved.quote({
			kind: "convert",
			amountIn: money("1000000000", "USDC"),
			outCurrency: "BRL",
		})
	})
})

describe("DueAdapter execute", () => {
	it("convert records the step; payout creates recipient, receive quote and transfer", async () => {
		const api = fakeApi()
		const due = adapter(api, { senderWallet: "wlt_sender" })
		const conv = await due.execute({
			...legBase,
			legId: "leg_convert",
			kind: "convert",
			amountIn: money("1000000000", "USDC"),
			outCurrency: "BRL",
		})
		expect(conv.externalRef).toBe("due-convert:USDC:leg_convert:1")
		expect(api.calls).toHaveLength(0)

		const out = await due.execute({
			...legBase,
			kind: "payout",
			amountIn: money("50000", "BRL"),
			outCurrency: "BRL",
			endpoint: PIX,
		})
		expect(out).toEqual({
			externalRef: "tfr_1",
			partnerRefs: { due_recipient_id: "rcp_1" },
		})
		const recipient = api.calls.find((c) => c.path === "/v1/recipients")!
		expect(recipient.body).toEqual({
			name: "Sandbox Tester",
			details: { schema: "bank_br_pix", pixKey: "tester@example.com" },
			isExternal: true,
		})
		const quote = api.calls
			.filter((c) => c.path === "/v1/transfers/quote")
			.at(-1)!
		expect(quote.body).toEqual({
			source: { rail: "solana-local", currency: "USDC", amount: "0" },
			destination: { rail: "brl_pix", currency: "BRL", amount: "500" },
		})
		const transfer = api.calls.find((c) => c.path === "/v1/transfers")!
		// brl_pix has no memo and no purpose codes.
		expect(transfer.body).toEqual({
			quote: "jwt.quote.token",
			recipient: "rcp_1",
			sender: "wlt_sender",
		})

		// Idempotent per (legId, attempt).
		const again = await due.execute({
			...legBase,
			kind: "payout",
			amountIn: money("50000", "BRL"),
			outCurrency: "BRL",
			endpoint: PIX,
		})
		expect(again).toEqual({ externalRef: "tfr_1" })
		// A retry reuses the recipient created for the endpoint.
		const retry = await due.execute({
			...legBase,
			attempt: 2,
			kind: "payout",
			amountIn: money("50000", "BRL"),
			outCurrency: "BRL",
			endpoint: PIX,
		})
		expect(retry).toEqual({ externalRef: "tfr_2" })
		expect(api.calls.filter((c) => c.path === "/v1/recipients")).toHaveLength(1)
	})

	it("reuses a persisted recipient and builds Colombian details with memo and purpose", async () => {
		const api = fakeApi()
		const due = adapter(api)
		const out = await due.execute({
			...legBase,
			kind: "payout",
			amountIn: money("10000000", "COP"),
			outCurrency: "COP",
			endpoint: {
				...PIX,
				partnerRefs: { due_recipient_id: "rcp_saved" },
				currency: "COP",
			},
		})
		expect(out).toEqual({ externalRef: "tfr_1" })
		expect(api.calls.some((c) => c.path === "/v1/recipients")).toBe(false)
		const transfer = api.calls.find((c) => c.path === "/v1/transfers")!
		// cop_local memo is 1..6 characters; purpose OTHER is offered.
		expect(transfer.body).toEqual({
			quote: "jwt.quote.token",
			recipient: "rcp_saved",
			memo: "FlexiP",
			purposeCode: "OTHER",
		})

		const fresh = adapter(fakeApi())
		await fresh.execute({
			...legBase,
			kind: "payout",
			amountIn: money("10000000", "COP"),
			outCurrency: "COP",
			endpoint: CO,
		})
		const api2 = fakeApi()
		const co = adapter(api2, { purposeCode: "PERSONAL_TRANSFER" })
		await co.execute({
			...legBase,
			kind: "payout",
			amountIn: money("10000000", "COP"),
			outCurrency: "COP",
			endpoint: CO,
		})
		const rec = api2.calls.find((c) => c.path === "/v1/recipients")!
		expect(rec.body.details).toEqual({
			schema: "bank_colombia",
			accountType: "individual",
			firstName: "Ana Maria",
			lastName: "Test",
			financialInstitutionId: "co_bank_1",
			bankAccountType: "ch",
			accountNumber: "123456789",
			idType: "cc",
			idNumber: "1234567890",
		})
		expect(
			api2.calls.find((c) => c.path === "/v1/transfers")!.body.purposeCode,
		).toBe("PERSONAL_TRANSFER")
	})

	it("business recipients use companyName; INR picks a kind-specific purpose code", async () => {
		const api = fakeApi()
		const due = adapter(api, { purposeCode: "NOT_OFFERED" })
		await due.execute({
			...legBase,
			kind: "payout",
			amountIn: money("100000", "INR"),
			outCurrency: "INR",
			endpoint: {
				endpointId: "ep_in",
				type: "bank_account",
				country: "IN",
				currency: "INR",
				details: { accountNumber: "tester@upi" },
				recipientName: "Acme Test Ltd",
				recipientKind: "company",
			},
		})
		const rec = api.calls.find((c) => c.path === "/v1/recipients")!
		expect(rec.body.details).toEqual({
			schema: "bank_in_upi",
			accountType: "business",
			companyName: "Acme Test Ltd",
			accountNumber: "tester@upi",
		})
		const transfer = api.calls.find((c) => c.path === "/v1/transfers")!
		// inr_upi memo needs 10+ characters, so none is sent; no business codes, so none either.
		expect(transfer.body).toEqual({
			quote: "jwt.quote.token",
			recipient: "rcp_1",
		})

		const api2 = fakeApi()
		await adapter(api2).execute({
			...legBase,
			kind: "payout",
			amountIn: money("100000", "INR"),
			outCurrency: "INR",
			endpoint: {
				endpointId: "ep_in2",
				type: "bank_account",
				country: "IN",
				currency: "INR",
				details: { accountNumber: "solo@upi" },
				recipientName: "Solo",
				recipientKind: "individual",
			},
		})
		expect(
			api2.calls.find((c) => c.path === "/v1/recipients")!.body.details,
		).toMatchObject({
			firstName: "Solo",
			lastName: "Solo",
		})
		expect(
			api2.calls.find((c) => c.path === "/v1/transfers")!.body.purposeCode,
		).toBe("FAMILY_SUPPORT")
	})

	it("a GBP-funded payout has no sender wallet and a memo within the rail limits", async () => {
		const api = fakeApi()
		const due = adapter(api, { senderWallet: "wlt_sender" })
		await due.execute({
			...legBase,
			legId: "leg_convert",
			kind: "convert",
			amountIn: money("10000000", "TGBP"),
			outCurrency: "MXN",
		})
		await due.execute({
			...legBase,
			kind: "payout",
			amountIn: money("100000", "MXN"),
			outCurrency: "MXN",
			endpoint: {
				endpointId: "ep_mx",
				type: "bank_account",
				country: "MX",
				currency: "MXN",
				details: {
					accountNumber: "1",
					clabe: "002010077777777771",
					accountHolderName: "Holder Name",
				},
				recipientName: "Sandbox Tester",
				recipientKind: "individual",
			},
		})
		const quote = api.calls
			.filter((c) => c.path === "/v1/transfers/quote")
			.at(-1)!
		expect(quote.body.source).toEqual({
			rail: "fp",
			currency: "GBP",
			amount: "0",
		})
		expect(
			api.calls.find((c) => c.path === "/v1/recipients")!.body.details,
		).toEqual({
			schema: "bank_mexico",
			clabe: "002010077777777771",
			beneficiaryName: "Holder Name",
		})
		expect(api.calls.find((c) => c.path === "/v1/transfers")!.body).toEqual({
			quote: "jwt.quote.token",
			recipient: "rcp_1",
			memo: "FlexiPay",
		})
	})

	it("refuses a payout it cannot build, before creating anything", async () => {
		const api = fakeApi()
		const due = adapter(api)
		const payout = (endpoint: EndpointRef | undefined, currency = "BRL") =>
			due.execute({
				...legBase,
				legId: `leg_${Math.random()}`,
				kind: "payout",
				amountIn: money("50000", currency),
				outCurrency: currency,
				endpoint,
			})
		await expect(payout(undefined)).rejects.toThrow(
			/needs the recipient's bank details/,
		)
		await expect(payout({ ...PIX, recipientName: undefined })).rejects.toThrow(
			/recipient name/,
		)
		await expect(
			payout({ ...PIX, details: { accountNumber: "1" } }),
		).rejects.toThrow(/missing pixKey \(Due pixKey\)/)
		await expect(
			payout(
				{
					...PIX,
					country: "PH",
					currency: "PHP",
					details: { accountNumber: "1" },
				},
				"PHP",
			),
		).rejects.toThrow(
			/missing bankCode \(Due financialInstitutionId\), branchCode, beneficiaryAddress/,
		)
		await expect(
			due.execute({
				...legBase,
				kind: "payout",
				amountIn: money("50000", "USDC"),
				outCurrency: "BRL",
				endpoint: PIX,
			}),
		).rejects.toMatchObject({ code: "currency_mismatch" })
		expect(
			api.calls.some(
				(c) => c.method === "POST" && c.path !== "/v1/transfers/quote",
			),
		).toBe(false)
	})

	it("fails when the schema is unknown, or Due returns no ids", async () => {
		const ng = adapter(fakeApi())
		expect(await ng.payoutRequirements("NG", "NGN")).toBeNull()
		await expect(
			ng.execute({
				...legBase,
				kind: "payout",
				amountIn: money("50000", "NGN"),
				outCurrency: "NGN",
				endpoint: { ...PIX, country: "NG", currency: "NGN" },
			}),
		).rejects.toThrow(/no recipient schema bank_africa/)
		const leg = {
			...legBase,
			kind: "payout" as const,
			amountIn: money("50000", "BRL"),
			outCurrency: "BRL",
			endpoint: PIX,
		}
		await expect(
			adapter(fakeApi({ recipientNoId: true })).execute(leg),
		).rejects.toThrow(/returned no id/)
		await expect(
			adapter(fakeApi({ transferNoId: true })).execute(leg),
		).rejects.toThrow(/create transfer returned no id/)
		await expect(
			adapter(fakeApi({ quoteNoToken: true })).execute(leg),
		).rejects.toThrow(/returned no token/)
		// Due deduplicates recipients: an existing match is reused, otherwise the 409 is refused.
		const taken = { ...PIX, details: { accountNumber: "1", pixKey: "taken" } }
		await expect(
			adapter(fakeApi()).execute({ ...leg, endpoint: taken }),
		).resolves.toEqual({
			externalRef: "tfr_1",
			partnerRefs: { due_recipient_id: "rcp_existing" },
		})
		await expect(
			adapter(fakeApi()).execute({
				...leg,
				endpoint: {
					...PIX,
					details: { accountNumber: "1", pixKey: "taken_elsewhere" },
				},
			}),
		).rejects.toThrow(/HTTP 409 err_recipient_already_exists/)
		await expect(
			adapter(fakeApi({ recipientsListFails: true })).execute({
				...leg,
				endpoint: taken,
			}),
		).rejects.toMatchObject({ code: "unsupported" })
		await expect(
			adapter(fakeApi({ schemasFail: true })).execute(leg),
		).rejects.toThrow(/schemas failed \(HTTP 500/)
	})

	it("returns funding instructions: Due's address for USDC, deposit details for GBP", async () => {
		const api = fakeApi()
		const due = adapter(api)
		expect(await due.fundingInstructions("tfr_1")).toEqual({
			amount: "91.525414",
			currency: "USDC",
			rail: "solana-local",
			details: { schema: "solana", address: "FundingAddr111" },
			address: "FundingAddr111",
			status: "awaiting_funds",
			expiresAt: "2026-11-09T14:00:00Z",
		})
		expect(await due.fundingInstructions("tfr_gbp")).toMatchObject({
			currency: "GBP",
			rail: "fp",
			details: { schema: "bank_uk", sortCode: "000000" },
		})
		expect(
			api.calls.filter((c) => c.path.endsWith("/funding_address")),
		).toHaveLength(1)
	})
})

describe("DueAdapter status, reverse, health, requirements", () => {
	it("maps every documented transfer status", async () => {
		const expected: Record<string, string> = {
			awaiting_funds: "processing",
			funds_received: "processing",
			approved: "processing",
			manual_review: "processing",
			action_required: "processing",
			payment_submitted: "processing",
			payment_processed: "succeeded",
			failed: "failed",
			canceled: "failed",
			refund_submitted: "failed",
			refund_processed: "failed",
			something_new: "processing",
		}
		for (const [raw, status] of Object.entries(expected)) {
			const state = await adapter(fakeApi({ transferStatus: raw })).status(
				"tfr_1",
			)
			expect(state.status).toBe(status)
			if (status === "failed") {
				expect(state.error?.code).toBe(
					{
						failed: "provider_down",
						canceled: "partner_canceled",
						refund_submitted: "returning_to_wallet",
						refund_processed: "returned_to_wallet",
					}[raw],
				)
				expect(state.error?.message).toContain(`(Due transfer ${raw})`)
			} else expect(state.error).toBeUndefined()
		}
		expect(await adapter(fakeApi()).status("due-convert:USDC:leg:1")).toEqual({
			status: "succeeded",
			externalRef: "due-convert:USDC:leg:1",
		})
		await expect(
			adapter(fakeApi({ transferMissing: true })).status("tfr_x"),
		).rejects.toMatchObject({
			code: "unknown_reference",
		})
	})

	it("reverses only the convert record", async () => {
		const due = adapter(fakeApi())
		expect(await due.reverse("due-convert:USDC:leg:1")).toEqual({
			externalRef: "due-convert:USDC:leg:1:reversed",
		})
		await expect(due.reverse("tfr_1")).rejects.toMatchObject({
			code: "not_reversible",
		})
	})

	it("health reads the channels and caches the answer for a minute", async () => {
		let t = 0
		const api = fakeApi()
		const due = adapter(api, { now: () => t })
		expect(await due.health()).toBe("up")
		expect(await due.health()).toBe("up")
		expect(api.calls.filter((c) => c.path === "/v1/channels")).toHaveLength(1)
		t += 61_000
		expect(await due.health()).toBe("up")
		expect(api.calls.filter((c) => c.path === "/v1/channels")).toHaveLength(2)
		expect(due.mode()).toBe("sandbox")
		expect(await adapter(fakeApi({ channelsFail: true })).health()).toBe("down")
		expect(await adapter(fakeApi({ channelsEmpty: true })).health()).toBe(
			"down",
		)
		expect(await adapter(fakeApi({ channelsObject: true })).health()).toBe("up")
	})

	it("derives payout requirements from the channel's recipient schema", async () => {
		const api = fakeApi()
		const due = adapter(api)
		expect(await due.payoutRequirements("BR", "BRL")).toEqual({
			detailKeys: ["pixKey"],
			localFields: [],
		})
		expect(await due.payoutRequirements("CO", "COP")).toEqual({
			detailKeys: [
				"bankCode",
				"accountType",
				"accountNumber",
				"documentType",
				"documentId",
			],
			localFields: [],
		})
		expect(await due.payoutRequirements("MX", "MXN")).toEqual({
			detailKeys: ["clabe"],
			localFields: [],
		})
		expect(await due.payoutRequirements("PH", "PHP")).toEqual({
			detailKeys: ["bankCode", "accountNumber", "branchCode"],
			localFields: ["address.line1", "address.city", "beneficiaryAddress.zone"],
		})
		expect(await due.payoutRequirements("US", "USD")).toBeNull()
		// Channels and schemas are each read once.
		expect(api.calls.filter((c) => c.path === "/v1/schemas")).toHaveLength(1)
		expect(api.calls.filter((c) => c.path === "/v1/channels")).toHaveLength(1)
		const gbp = adapter(
			fakeApi(),
			{},
			{ ...ROW, currencies: [...ROW.currencies, "GBP"] },
		)
		expect(await gbp.payoutRequirements("GB", "GBP")).toBeNull()
	})
})

describe("Due helpers and registration", () => {
	it("converts decimals both ways, rounding down", () => {
		expect(decimalToMinor("546.29", 2)).toBe(54629n)
		expect(decimalToMinor("0.301125", 7)).toBe(3011250n)
		expect(decimalToMinor("12.999", 2)).toBe(1299n)
		expect(decimalToMinor("7", 0)).toBe(7n)
		expect(decimalToMinor(1.5, 2)).toBe(150n)
		expect(decimalToMinor("-1", 2)).toBeNull()
		expect(decimalToMinor(undefined, 2)).toBeNull()
		expect(minorToDecimal(1000000000n, 7, 6)).toBe("100")
		expect(minorToDecimal(1234567n, 7, 6)).toBe("0.123456")
		expect(minorToDecimal(50000n, 2)).toBe("500")
		expect(minorToDecimal(50001n, 2)).toBe("500.01")
		expect(minorToDecimal(42n, 0)).toBe("42")
	})

	const config = { providers: [ROW] } as unknown as FlexiPayConfig

	it("registers with sandbox keys, prefers production keys, and skips without keys", () => {
		expect(createLiveProviders(config, {}).skipped).toEqual(["due_sandbox"])
		expect(
			createLiveProviders(config, { DUE_SANDBOX_API_KEY: "k" }).skipped,
		).toEqual(["due_sandbox"])
		const sandbox = createLiveProviders(config, {
			DUE_SANDBOX_API_KEY: "k",
			DUE_SANDBOX_ACCOUNT_ID: "acct",
		}).providers.get("due_sandbox") as DueAdapter
		expect(sandbox).toBeInstanceOf(DueAdapter)
		expect(sandbox.mode()).toBe("sandbox")
		const live = createLiveProviders(config, {
			DUE_SANDBOX_API_KEY: "k",
			DUE_SANDBOX_ACCOUNT_ID: "acct",
			DUE_API_KEY: "live",
			DUE_ACCOUNT_ID: "acct_live",
			DUE_SENDER_WALLET: "wlt_1",
			DUE_SOLANA_RAIL: "solana",
			DUE_PURPOSE_CODE: "OTHER",
		}).providers.get("due_sandbox") as DueAdapter
		expect(live.mode()).toBe("live")
	})

	it("sends the production keys and Solana rail to production", async () => {
		const api = fakeApi()
		const { providers } = createLiveProviders(
			config,
			{
				DUE_API_KEY: "live",
				DUE_ACCOUNT_ID: "acct_live",
				FP_DUE_LIVE_APPROVED: "1",
			},
			{ fetch: api.fetch },
		)
		await providers.get("due_sandbox")!.quote({
			kind: "convert",
			amountIn: money("1000000000", "USDC"),
			outCurrency: "BRL",
		})
		const call = api.calls.find((c) => c.path === "/v1/transfers/quote")!
		expect(call.headers["Due-Account-Id"]).toBe("acct_live")
		expect(call.body.source.rail).toBe("solana")
	})
})

describe("DueAdapter sender wallet (CCR-51)", () => {
	const payoutLeg = {
		...legBase,
		kind: "payout" as const,
		amountIn: money("50000", "BRL"),
		outCurrency: "BRL",
		endpoint: PIX,
	}

	it("links the sender's Solana wallet once: reuses a linked one, else creates it", async () => {
		const api = fakeApi()
		const due = adapter(api)
		expect(await due.linkSolanaWallet("KnownWallet111")).toBe("wlt_known")
		expect(await due.linkSolanaWallet("NewWallet222")).toBe("wlt_new")
		expect(await due.linkSolanaWallet("NewWallet222")).toBe("wlt_new")
		const posts = api.calls.filter(
			(c) => c.path === "/v1/wallets" && c.method === "POST",
		)
		expect(posts).toHaveLength(1)
		expect(posts[0]!.body).toEqual({ address: "solana:NewWallet222" })
		expect(
			await adapter(fakeApi({ wallets: { items: [] } })).linkSolanaWallet("X1"),
		).toBe("wlt_new")
		expect(
			await adapter(fakeApi({ walletsFail: true })).linkSolanaWallet("X2"),
		).toBe("wlt_new")
		await expect(
			adapter(fakeApi({ walletNoId: true })).linkSolanaWallet("X3"),
		).rejects.toThrow(/no id/)
	})

	it("creates the transfer with the sender's wallet as Due sender and the USDC source", async () => {
		const api = fakeApi()
		const due = adapter(api, { senderWallet: "wlt_platform" })
		const out = await due.createSenderWalletTransfer(payoutLeg, "wlt_known")
		expect(out.externalRef).toBe("tfr_1")
		const transfer = api.calls.find(
			(c) => c.path === "/v1/transfers" && c.method === "POST",
		)!
		expect(transfer.body.sender).toBe("wlt_known")
		const quote = api.calls.filter((c) => c.path === "/v1/transfers/quote").at(-1)!
		expect(quote.body.source).toEqual({
			rail: "solana-local",
			currency: "USDC",
			amount: "0",
		})
		// Same leg attempt: no second transfer.
		expect(
			(await due.createSenderWalletTransfer(payoutLeg, "wlt_known")).externalRef,
		).toBe("tfr_1")
		await expect(
			due.createSenderWalletTransfer(
				{ ...payoutLeg, kind: "convert" },
				"wlt_known",
			),
		).rejects.toMatchObject({ code: "unsupported" })
		await expect(
			due.createSenderWalletTransfer(
				{ ...payoutLeg, outCurrency: "MXN" },
				"wlt_known",
			),
		).rejects.toMatchObject({ code: "currency_mismatch" })
	})

	it("encodes a Solana funding address that Due sends as bytes", async () => {
		const bytes = Array.from({ length: 32 }, (_, i) => (i === 0 ? 0 : i))
		const info = await adapter(fakeApi({ fundingBytes: bytes })).fundingInstructions(
			"tfr_1",
		)
		expect(info.address).toMatch(/^1[1-9A-HJ-NP-Za-km-z]{30,44}$/)
		expect(addressText([1, 2, 3])).toBeNull()
		expect(addressText("")).toBeNull()
		expect(addressText(new Array(32).fill(0))).toBe("1".repeat(32))
	})

	it("treats awaiting_funds well past expiresAt as expired, not processing", async () => {
		const expiresAt = "2026-11-09T14:00:00Z"
		const at = Date.parse(expiresAt)
		const within = await adapter(fakeApi({ expiresAt }), {
			now: () => at + DUE_FUNDING_GRACE_MS - 1,
		}).status("tfr_1")
		expect(within.status).toBe("processing")
		const after = await adapter(fakeApi({ expiresAt }), {
			now: () => at + DUE_FUNDING_GRACE_MS + 1,
		}).status("tfr_1")
		expect(after).toMatchObject({
			status: "failed",
			error: { code: "funding_expired" },
		})
		const noExpiry = await adapter(fakeApi({ expiresAt: "not a date" }), {
			now: () => at * 2,
		}).status("tfr_1")
		expect(noExpiry.status).toBe("processing")
	})
})
