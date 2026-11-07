import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, test, vi } from "vitest"
import {
	API_GAVE_UP_MESSAGE,
	API_KEY_REJECTED_MESSAGE,
	API_REQUEST_TIMEOUT_MS,
	API_WAKE_UP_MESSAGE,
	ApiError,
	AUTH_NOT_CONFIGURED_MESSAGE,
	createApiKey,
	createEndpoint,
	createOnrampOrder,
	createPayment,
	createQuote,
	createRecipient,
	describeApiError,
	fundPayment,
	getPayment,
	getQuote,
	isAuthRequired,
	isTransientApiError,
	listApiKeys,
	listCorridors,
	listEndpoints,
	listPayments,
	listRecipients,
	newIdempotencyKey,
	revokeApiKey,
	SESSION_ENDED_MESSAGE,
	setCustomerSessionActive,
	UNAUTHORIZED_EVENT,
} from "../src/api/client.ts"

type Call = { url: string; init: RequestInit }
const calls: Call[] = []

const respond = (status: number, body: unknown) =>
	vi.fn(async (url: string, init: RequestInit) => {
		calls.push({ url, init })
		return new Response(
			body === undefined
				? null
				: typeof body === "string"
					? body
					: JSON.stringify(body),
			{ status },
		)
	})

const stubFetch = (status: number, body: unknown) => {
	const fn = respond(status, body)
	vi.stubGlobal("fetch", fn)
	return fn
}

const rejection = async (promise: Promise<unknown>): Promise<ApiError> => {
	try {
		await promise
	} catch (error) {
		assert.ok(
			error instanceof ApiError,
			`expected ApiError, got ${String(error)}`,
		)
		return error
	}
	assert.fail("expected the request to fail")
}

beforeEach(() => {
	calls.length = 0
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.useRealTimers()
	setCustomerSessionActive(false)
})

const endpointRow = {
	id: "ep_1",
	organizationId: "org",
	recipientId: "rcp_1",
	type: "bank_account",
	country: "PH",
	currency: "PHP",
	network: null,
	details: { accountNumber: "••••3210" },
	simulated: true,
	createdAt: "2026-11-01T00:00:00.000Z",
}

describe("request error mapping", () => {
	test("401 dispatches the unauthorized event and names the key problem in proxy mode", async () => {
		stubFetch(401, { code: "unauthorized", message: "raw" })
		const seen: string[] = []
		const target = new EventTarget()
		target.addEventListener(UNAUTHORIZED_EVENT, (e) => seen.push(e.type))
		vi.stubGlobal("dispatchEvent", target.dispatchEvent.bind(target))
		const error = await rejection(listPayments())
		assert.equal(error.status, 401)
		assert.equal(error.code, "auth_required")
		assert.equal(error.message, API_KEY_REJECTED_MESSAGE)
		assert.deepEqual(seen, [UNAUTHORIZED_EVENT])
		assert.equal(isAuthRequired(error), true)
	})

	test("401 for a signed-in customer says the session ended", async () => {
		setCustomerSessionActive(true)
		stubFetch(401, undefined)
		const error = await rejection(listPayments())
		assert.equal(error.message, SESSION_ENDED_MESSAGE)
	})

	test("frontend_auth_not_configured gets the setup message", async () => {
		stubFetch(503, { code: "frontend_auth_not_configured" })
		const error = await rejection(listRecipients())
		assert.equal(error.message, AUTH_NOT_CONFIGURED_MESSAGE)
		assert.equal(isAuthRequired(error), true)
		// Auth-blocked codes are never treated as a cold start.
		assert.equal(isTransientApiError(error), false)
	})

	test("5xx becomes the wake-up message; 4xx keeps the API message or a fallback", async () => {
		stubFetch(502, "")
		const cold = await rejection(listPayments())
		assert.equal(cold.code, "http_502")
		assert.equal(cold.message, API_WAKE_UP_MESSAGE)
		assert.equal(isTransientApiError(cold), true)
		assert.equal(describeApiError(cold), API_WAKE_UP_MESSAGE)

		stubFetch(422, {
			code: "unprocessable",
			message: "No route.",
			details: { reasons: ["too small", 3] },
		})
		const invalid = await rejection(listPayments())
		assert.equal(invalid.code, "unprocessable")
		assert.deepEqual(invalid.reasons, ["too small"])
		assert.equal(describeApiError(invalid), "No route. too small")

		stubFetch(409, ["not", "an", "object"])
		const conflict = await rejection(listPayments())
		assert.equal(conflict.code, "http_409")
		assert.equal(conflict.message, "API request failed (HTTP 409).")
	})

	test("non-JSON bodies and contract mismatches are invalid_response", async () => {
		stubFetch(200, "<html>")
		const html = await rejection(listPayments())
		assert.equal(html.code, "invalid_response")
		assert.match(html.message, /non-JSON response \(HTTP 200\)/)

		stubFetch(200, { payments: [{ id: 1 }] })
		const bad = await rejection(listPayments())
		assert.equal(bad.code, "invalid_response")
		assert.match(bad.message, /A0 contract/)
	})

	test("network failures and the request timeout map to wake-up errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed")
			}),
		)
		const offline = await rejection(listPayments())
		assert.equal(offline.code, "network_error")
		assert.equal(isTransientApiError(offline), true)

		vi.useFakeTimers()
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init: RequestInit) =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener("abort", () =>
							reject(new DOMException("aborted", "AbortError")),
						)
					}),
			),
		)
		const pending = rejection(listPayments())
		await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS)
		const timedOut = await pending
		assert.equal(timedOut.code, "api_waking")
	})

	test("a caller abort is rethrown as the AbortError, not a wake-up", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init: RequestInit) =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener("abort", () =>
							reject(new DOMException("aborted", "AbortError")),
						)
					}),
			),
		)
		const controller = new AbortController()
		const pending = listPayments(controller.signal)
		controller.abort()
		await assert.rejects(pending, (error: unknown) => {
			assert.ok(error instanceof DOMException)
			assert.equal(error.name, "AbortError")
			return true
		})
	})
})

describe("ApiError helpers", () => {
	test("reasons accept an array or a {reasons} object and ignore other shapes", () => {
		assert.deepEqual(new ApiError(422, "x", "m", ["a", 1, "b"]).reasons, [
			"a",
			"b",
		])
		assert.deepEqual(
			new ApiError(422, "x", "m", { reasons: "nope" }).reasons,
			[],
		)
		assert.deepEqual(new ApiError(422, "x", "m", { other: 1 }).reasons, [])
		assert.deepEqual(new ApiError(422, "x", "m").reasons, [])
	})

	test("transient detection covers internal_error and http_5xx codes", () => {
		assert.equal(
			isTransientApiError(new ApiError(0, "internal_error", "")),
			true,
		)
		assert.equal(isTransientApiError(new ApiError(400, "http_500", "")), true)
		assert.equal(isTransientApiError(new ApiError(400, "bad", "")), false)
		assert.equal(isTransientApiError(new Error("x")), false)
		assert.equal(isAuthRequired(new Error("x")), false)
		assert.equal(isAuthRequired(new ApiError(403, "forbidden", "")), false)
	})

	test("describeApiError joins message and reasons, dropping empties", () => {
		assert.equal(describeApiError(new ApiError(400, "bad", "")), "")
		assert.equal(
			describeApiError(new ApiError(400, "bad", "Bad.", ["one", "two"])),
			"Bad. one two",
		)
		assert.notEqual(API_GAVE_UP_MESSAGE, API_WAKE_UP_MESSAGE)
	})

	test("idempotency keys are prefixed and unique", () => {
		const a = newIdempotencyKey("quote")
		assert.match(a, /^quote-[0-9a-f-]{36}$/)
		assert.notEqual(a, newIdempotencyKey("quote"))
	})
})

describe("endpoint and request wiring", () => {
	test("POSTs send JSON, an Idempotency-Key and no Authorization header", async () => {
		stubFetch(422, { code: "quote_invalid", message: "no" })
		await rejection(createQuote({} as never))
		await rejection(createPayment({} as never, "pay-key"))
		await rejection(fundPayment("pay/1", "fund-key"))
		await rejection(getQuote("q 1"))
		await rejection(getPayment("p?1"))
		assert.deepEqual(
			calls.map((c) => [c.url, c.init.method]),
			[
				["/v1/quotes", "POST"],
				["/v1/payments", "POST"],
				["/v1/payments/pay%2F1/fund", "POST"],
				["/v1/quotes/q%201", "GET"],
				["/v1/payments/p%3F1", "GET"],
			],
		)
		const headers = calls[1]?.init.headers as Headers
		assert.equal(headers.get("Idempotency-Key"), "pay-key")
		assert.equal(headers.get("Content-Type"), "application/json")
		assert.equal(headers.get("Authorization"), null)
		assert.equal(calls[2]?.init.body, "{}")
		assert.match(
			(calls[0]?.init.headers as Headers).get("Idempotency-Key") ?? "",
			/^quote-/,
		)
		// GET requests carry no body or content type.
		const get = calls[3]?.init.headers as Headers
		assert.equal(get.get("Content-Type"), null)
		assert.equal(calls[3]?.init.body, undefined)
	})

	test("listPayments accepts an empty list", async () => {
		stubFetch(200, { payments: [] })
		assert.deepEqual(await listPayments(), { payments: [] })
	})

	test("endpoints: list with recipient filter, create, and strict row checks", async () => {
		stubFetch(200, { endpoints: [endpointRow] })
		const listed = await listEndpoints({ recipientId: "rcp 1" })
		assert.equal(calls[0]?.url, "/v1/endpoints?recipientId=rcp%201")
		assert.equal(listed.endpoints[0]?.details.accountNumber, "••••3210")

		stubFetch(200, { endpoints: [] })
		await listEndpoints()
		assert.equal(calls[1]?.url, "/v1/endpoints")

		stubFetch(201, { ...endpointRow, network: "solana" })
		const created = await createEndpoint(
			{
				recipientId: "rcp_1",
				type: "crypto_wallet",
				country: "",
				currency: "TGBP",
				network: "solana",
				details: { address: "x" },
				simulated: true,
			},
			"ep-key",
		)
		assert.equal(created.network, "solana")

		for (const bad of [
			{ endpoints: "nope" },
			{ endpoints: [{ ...endpointRow, network: "eth" }] },
			{ endpoints: [{ ...endpointRow, details: { accountNumber: 1 } }] },
			{ endpoints: [{ ...endpointRow, simulated: false }] },
			{ endpoints: [null] },
		]) {
			stubFetch(200, bad)
			const error = await rejection(listEndpoints())
			assert.equal(error.code, "invalid_response")
		}
	})

	test("recipients: create needs an id; list rows are validated", async () => {
		stubFetch(201, { id: "" })
		assert.equal(
			(
				await rejection(
					createRecipient(
						{ name: "A", kind: "individual", country: "PH" },
						"rcp-key",
					),
				)
			).code,
			"invalid_response",
		)
		stubFetch(200, { recipients: [{ id: "r", name: "A" }] })
		assert.equal((await rejection(listRecipients())).code, "invalid_response")
		stubFetch(200, {})
		assert.equal((await rejection(listRecipients())).code, "invalid_response")
	})

	test("corridors: optional legs, string filtering and invalid rows", async () => {
		const row = {
			from: { country: "GB", currency: "GBP" },
			to: { country: "PH", currency: "PHP" },
			allowedDestinationTypes: ["bank_account", 7],
			recipientKinds: ["individual", null],
			regulationNote: "note",
			simulated: true,
		}
		stubFetch(200, {
			corridors: [
				row,
				{ ...row, legsAvailable: { settle: ["solana_tgbp", 1], payout: "x" } },
			],
		})
		const { corridors } = await listCorridors()
		assert.deepEqual(corridors[0]?.allowedDestinationTypes, ["bank_account"])
		assert.deepEqual(corridors[0]?.recipientKinds, ["individual"])
		assert.equal("settleRails" in (corridors[0] ?? {}), false)
		assert.deepEqual(corridors[1]?.settleRails, ["solana_tgbp"])
		assert.equal("payoutProviders" in (corridors[1] ?? {}), false)

		stubFetch(200, { corridors: [{ ...row, simulated: "yes" }] })
		assert.equal((await rejection(listCorridors())).code, "invalid_response")
		stubFetch(200, { nope: true })
		assert.equal((await rejection(listCorridors())).code, "invalid_response")
	})

	test("api keys: create trims labels, revoke encodes ids, rows are validated", async () => {
		const keyRow = {
			id: "key 1",
			prefix: "fp_live_ab",
			label: null,
			createdAt: "2026-11-01T00:00:00.000Z",
			revokedAt: null,
		}
		stubFetch(201, { ...keyRow, key: "fp_live_secret" })
		const created = await createApiKey({ label: "  CI  " })
		assert.equal(created.key, "fp_live_secret")
		assert.equal(calls[0]?.init.body, JSON.stringify({ label: "CI" }))

		stubFetch(201, { ...keyRow, key: "fp_live_secret" })
		await createApiKey({ label: "   " })
		await createApiKey()
		assert.equal(calls[1]?.init.body, "{}")
		assert.equal(calls[2]?.init.body, "{}")

		stubFetch(201, { ...keyRow, key: "" })
		assert.equal((await rejection(createApiKey())).code, "invalid_response")

		stubFetch(200, { ...keyRow, revokedAt: "2026-11-02T00:00:00.000Z" })
		const revoked = await revokeApiKey("key 1")
		assert.equal(revoked.revokedAt, "2026-11-02T00:00:00.000Z")
		assert.equal(calls.at(-1)?.url, "/v1/api-keys/key%201/revoke")

		stubFetch(200, { keys: [{ ...keyRow, label: 5 }] })
		assert.equal((await rejection(listApiKeys())).code, "invalid_response")
		stubFetch(200, { keys: null })
		assert.equal((await rejection(listApiKeys())).code, "invalid_response")
	})

	test("onramp orders need an order id and client secret", async () => {
		stubFetch(201, { orderId: "o1", clientSecret: "cs" })
		const order = await createOnrampOrder({
			walletAddress: "w",
			amountUsd: "10",
		})
		assert.deepEqual(order, { orderId: "o1", clientSecret: "cs" })
		assert.match(
			(calls[0]?.init.headers as Headers).get("Idempotency-Key") ?? "",
			/^onramp-/,
		)
		stubFetch(201, { orderId: "o1", clientSecret: "" })
		assert.equal(
			(
				await rejection(
					createOnrampOrder({ walletAddress: "w", amountUsd: "1" }),
				)
			).code,
			"invalid_response",
		)
	})
})
