import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, test, vi } from "vitest"
import {
	type AuthRequestError,
	changePassword,
	fetchSession,
	requestPasswordReset,
	resendVerification,
	resetPassword,
	signIn,
	signOut,
	signUp,
} from "../src/api/auth.ts"
import {
	acceptClaim,
	ClaimApiError,
	claimRequest,
	describeClaimError,
	getClaim,
	tokenPath,
} from "../src/api/claimClient.ts"
import { ApiError } from "../src/api/client.ts"
import {
	createPaymentRequest,
	getPaymentRequest,
	parsePaymentRequest,
} from "../src/api/paymentRequests.ts"
import {
	confirmSolanaTransfer,
	getSolanaConfig,
	getSolanaIntent,
	parseSolanaConfig,
	parseSolanaIntent,
	preferredAssetFromConfig,
} from "../src/api/solanaClient.ts"

type Call = { url: string; init: RequestInit | undefined }
const calls: Call[] = []

const stubFetch = (status: number, body?: unknown) => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, init })
			return new Response(
				body === undefined
					? null
					: typeof body === "string"
						? body
						: JSON.stringify(body),
				{ status },
			)
		}),
	)
}

const stubFetchThrow = (error: unknown) =>
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw error
		}),
	)

const caught = async <E>(promise: Promise<unknown>): Promise<E> => {
	try {
		await promise
	} catch (error) {
		return error as E
	}
	assert.fail("expected a rejection")
}

beforeEach(() => {
	calls.length = 0
})
afterEach(() => {
	vi.unstubAllGlobals()
})

const claimView = {
	paymentId: "pay_1",
	status: "open",
	paymentStatus: "processing",
	expiresAt: "2026-11-08T00:00:00.000Z",
	amount: { amount: "1000", currency: "PHP" },
	corridor: {
		from: { country: "GB", currency: "GBP" },
		to: { country: "PH", currency: "PHP" },
	},
	allowedDestinationTypes: ["bank_account"],
	simulated: true,
}

describe("claim client", () => {
	test("tokenPath encodes the raw token", () => {
		assert.equal(tokenPath("a/b c"), "/v1/claims/a%2Fb%20c")
	})

	test("getClaim parses a claim view without any auth header", async () => {
		stubFetch(200, claimView)
		const view = await getClaim("tok")
		assert.equal(view.paymentId, "pay_1")
		const headers = calls[0]?.init?.headers as Headers
		assert.equal(headers.get("Authorization"), null)
		assert.equal(headers.get("Content-Type"), null)
		assert.equal(calls[0]?.init?.method, "GET")
	})

	test("acceptClaim validates the endpoint before sending", async () => {
		stubFetch(200, {
			claim: { ...claimView, status: "accepted" },
			paymentId: "pay_1",
			paymentStatus: "processing",
		})
		const input = {
			endpoint: {
				type: "bank_account" as const,
				country: "PH",
				currency: "PHP",
				network: null,
				details: { accountNumber: "123456789" },
				simulated: true as const,
			},
		}
		const res = await acceptClaim("tok", input, "claim-key")
		assert.equal(res.claim.status, "accepted")
		assert.equal(calls[0]?.url, "/v1/claims/tok/accept")
		const headers = calls[0]?.init?.headers as Headers
		assert.equal(headers.get("Idempotency-Key"), "claim-key")
		assert.equal(headers.get("Content-Type"), "application/json")

		// Crypto endpoint with a country is rejected locally (no request made).
		assert.throws(() =>
			acceptClaim(
				"tok",
				{
					endpoint: {
						...input.endpoint,
						type: "crypto_wallet",
						network: "solana",
					},
				},
				"k",
			),
		)
		assert.equal(calls.length, 1)
	})

	test("maps HTTP failures to friendly claim messages", async () => {
		for (const [status, pattern] of [
			[404, /invalid or no longer exists/],
			[409, /current state/],
			[422, /endpoint was not accepted/],
			[500, /could not be loaded/],
		] as const) {
			stubFetch(status)
			const error = await caught<ClaimApiError>(getClaim("t"))
			assert.ok(error instanceof ClaimApiError)
			assert.equal(error.status, status)
			assert.equal(error.code, `http_${status}`)
			assert.match(error.message, pattern)
			assert.equal(describeClaimError(error), error.message)
		}

		stubFetch(410, { code: "claim_expired", message: "Expired.", details: 1 })
		const expired = await caught<ClaimApiError>(getClaim("t"))
		assert.equal(expired.code, "claim_expired")
		assert.equal(expired.message, "Expired.")
		assert.equal(expired.details, 1)
	})

	test("non-JSON, contract mismatch, network and abort errors", async () => {
		stubFetch(200, "<html>")
		assert.equal(
			(await caught<ClaimApiError>(getClaim("t"))).code,
			"invalid_response",
		)
		stubFetch(200, { ...claimView, simulated: false })
		assert.match(
			(await caught<ClaimApiError>(getClaim("t"))).message,
			/A0 contract/,
		)
		stubFetchThrow(new TypeError("offline"))
		assert.equal(
			(await caught<ClaimApiError>(getClaim("t"))).code,
			"network_error",
		)
		const abort = new DOMException("stop", "AbortError")
		stubFetchThrow(abort)
		assert.equal(await caught(getClaim("t")), abort)
	})

	test("claimRequest returns undefined payload to the schema for empty bodies", async () => {
		stubFetch(204)
		const value = await claimRequest("/x", {
			schema: { parse: (v) => ({ seen: v }) },
		})
		assert.deepEqual(value, { seen: undefined })
	})

	test("describeClaimError falls back when the message is blank", () => {
		assert.match(
			describeClaimError(new ClaimApiError(409, "c", " ")),
			/current state/,
		)
		assert.match(
			describeClaimError(new ClaimApiError(404, "c", "")),
			/no longer exists/,
		)
	})
})

describe("auth client", () => {
	test("fetchSession: identity, signed out, unconfigured and real errors", async () => {
		const me = {
			via: "session",
			organization: { id: "o", name: "O" },
			user: null,
		}
		stubFetch(200, me)
		assert.deepEqual(await fetchSession(), me)
		stubFetch(200, "")
		assert.equal(await fetchSession(), null)
		stubFetch(401, { code: "unauthorized" })
		assert.equal(await fetchSession(), null)
		stubFetch(503, { code: "frontend_api_not_configured" })
		assert.equal(await fetchSession(), "unconfigured")
		stubFetch(503, { code: "maintenance" })
		const down = await caught<AuthRequestError>(fetchSession())
		assert.equal(down.message, "Sign-in is not available on this server yet.")
		stubFetchThrow(new TypeError("offline"))
		const offline = await caught<AuthRequestError>(fetchSession())
		assert.equal(offline.code, "network_error")
		assert.equal(offline.status, 0)
	})

	test("error messages: rate limit, API message, fallback, junk body", async () => {
		stubFetch(429, { code: "rate_limited", message: "raw" })
		assert.match(
			(await caught<Error>(signIn({ email: "a", password: "b" }))).message,
			/Too many attempts/,
		)
		stubFetch(400, { code: "INVALID_EMAIL", message: "Invalid email" })
		const bad = await caught<AuthRequestError>(
			signIn({ email: "a", password: "b" }),
		)
		assert.equal(bad.code, "INVALID_EMAIL")
		assert.equal(bad.message, "Invalid email")
		stubFetch(400, "not json")
		const junk = await caught<AuthRequestError>(signOut())
		assert.equal(junk.code, "http_400")
		assert.equal(junk.message, "The request failed.")
	})

	test("each action POSTs JSON to its Better Auth route", async () => {
		stubFetch(200, { ok: true })
		await signUp({ name: "A", email: "a@b.c", password: "pw" })
		await signIn({ email: "a@b.c", password: "pw" })
		await signOut()
		await requestPasswordReset("a@b.c")
		await resetPassword({ token: "t", newPassword: "n" })
		await resendVerification("a@b.c")
		await changePassword({ currentPassword: "a", newPassword: "b" })
		assert.deepEqual(
			calls.map((c) => c.url),
			[
				"/api/auth/sign-up/email",
				"/api/auth/sign-in/email",
				"/api/auth/sign-out",
				"/api/auth/request-password-reset",
				"/api/auth/reset-password",
				"/api/auth/send-verification-email",
				"/api/auth/change-password",
			],
		)
		assert.ok(calls.every((c) => c.init?.method === "POST"))
		assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
			name: "A",
			email: "a@b.c",
			password: "pw",
			callbackURL: "/login?verified=1",
		})
		assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), {
			email: "a@b.c",
			redirectTo: "/reset-password",
		})
		assert.deepEqual(JSON.parse(String(calls[5]?.init?.body)), {
			email: "a@b.c",
			callbackURL: "/login?verified=1",
		})
	})
})

const paymentRequest = {
	id: " pr_1 ",
	status: "waiting",
	amount: { amount: "1250", currency: "TGBP" },
	merchantWallet: " Merchant111 ",
	reference: "ref",
	solanaPayUrl: "solana:abc",
	expiresAt: "2026-11-07T13:00:00.000Z",
}

describe("payment requests (CCR-27 till)", () => {
	test("parses and trims a waiting request without optional fields", () => {
		const parsed = parsePaymentRequest(paymentRequest)
		assert.equal(parsed.id, "pr_1")
		assert.equal(parsed.merchantWallet, "Merchant111")
		assert.equal("signature" in parsed, false)
		assert.equal("payer" in parsed, false)
	})

	test("keeps signature, explorer URL and payer once paid; drops blanks", () => {
		const paid = parsePaymentRequest({
			...paymentRequest,
			status: "paid",
			signature: " sig ",
			explorerUrl: "https://explorer",
			payer: " Payer ",
		})
		assert.equal(paid.signature, "sig")
		assert.equal(paid.explorerUrl, "https://explorer")
		assert.equal(paid.payer, "Payer")
		const blank = parsePaymentRequest({
			...paymentRequest,
			status: "expired",
			signature: " ",
			explorerUrl: "",
			payer: 3,
		})
		assert.equal(blank.status, "expired")
		assert.equal("signature" in blank, false)
		assert.equal("explorerUrl" in blank, false)
	})

	test("rejects anything off-contract with invalid_response", () => {
		for (const bad of [
			null,
			{ ...paymentRequest, status: "cancelled" },
			{ ...paymentRequest, amount: { amount: "1.5", currency: "TGBP" } },
			{ ...paymentRequest, amount: { amount: "100", currency: "GBP" } },
			{ ...paymentRequest, amount: "100" },
			{ ...paymentRequest, id: "  " },
			{ ...paymentRequest, merchantWallet: 1 },
			{ ...paymentRequest, reference: undefined },
			{ ...paymentRequest, solanaPayUrl: "" },
			{ ...paymentRequest, expiresAt: null },
		]) {
			assert.throws(
				() => parsePaymentRequest(bad),
				(e: unknown) => e instanceof ApiError && e.code === "invalid_response",
			)
		}
	})

	test("create POSTs JSON; get encodes the id; errors keep API code or fall back", async () => {
		stubFetch(201, paymentRequest)
		await createPaymentRequest({ amount: "1250", merchantWallet: "M" })
		assert.equal(calls[0]?.url, "/v1/payment-requests")
		assert.equal(calls[0]?.init?.method, "POST")
		assert.equal(
			calls[0]?.init?.body,
			JSON.stringify({ amount: "1250", merchantWallet: "M" }),
		)

		stubFetch(200, paymentRequest)
		await getPaymentRequest("pr/1")
		assert.equal(calls[1]?.url, "/v1/payment-requests/pr%2F1")

		stubFetch(422, { code: "amount_out_of_range", message: "Too big" })
		const big = await caught<ApiError>(
			createPaymentRequest({ amount: "9", merchantWallet: "M" }),
		)
		assert.equal(big.code, "amount_out_of_range")
		assert.equal(big.message, "Too big")

		stubFetch(500)
		const create = await caught<ApiError>(
			createPaymentRequest({ amount: "9", merchantWallet: "M" }),
		)
		assert.equal(create.code, "http_error")
		assert.equal(create.message, "Could not create the payment request.")

		stubFetch(404, {})
		const get = await caught<ApiError>(getPaymentRequest("x"))
		assert.equal(get.status, 404)
		assert.equal(get.message, "Could not load the payment request.")
	})
})

describe("solana client", () => {
	test("config: parses assets, drops bad rows, floors decimals", () => {
		const cfg = parseSolanaConfig({
			cluster: "devnet",
			usdcMint: " USDC111 ",
			usdcDecimals: 6.9,
			assets: [
				{ asset: "TGBP", mint: " TGBP111 ", decimals: 7.2 },
				{ asset: "EURC", mint: "x", decimals: 6 },
				{ asset: "USDC", mint: "", decimals: 6 },
				{ asset: "USDC", mint: "m", decimals: -1 },
				{ asset: "USDC", mint: "m", decimals: "6" },
				null,
			],
			explorerTxUrlTemplate: "https://x/{sig}",
			publicRpcUrl: "https://rpc",
			label: "Devnet",
		})
		assert.deepEqual(cfg.assets, [
			{ asset: "TGBP", mint: "TGBP111", decimals: 7 },
		])
		assert.equal(cfg.usdcMint, "USDC111")
		assert.equal(cfg.usdcDecimals, 6)
		assert.equal(cfg.publicRpcUrl, "https://rpc")
		assert.equal(cfg.label, "Devnet")
	})

	test("config: defaults for an empty or legacy payload", () => {
		const empty = parseSolanaConfig(null)
		assert.equal(empty.cluster, "devnet")
		assert.deepEqual(empty.assets, [])
		assert.equal(empty.usdcDecimals, 0)
		assert.equal(empty.explorerTxUrlTemplate, "")
		assert.equal(empty.publicRpcUrl, null)
		assert.equal(empty.label, "Solana")
		assert.equal(parseSolanaConfig({ publicRpcUrl: null }).publicRpcUrl, null)
		assert.equal(parseSolanaConfig({ publicRpcUrl: 5 }).publicRpcUrl, null)
	})

	test("intent: CCR-26 mint/decimals win; legacy aliases fall back both ways", () => {
		const tgbp = parseSolanaIntent({
			paymentId: "p",
			cluster: "devnet",
			asset: "TGBP",
			mint: " TGBP111 ",
			decimals: 7,
			amount: "10",
			recipient: "R",
			reference: "ref",
			intentIssuedAt: "now",
			label: "L",
			explorerTxUrlTemplate: "t",
		})
		assert.equal(tgbp.mint, "TGBP111")
		// No legacy usdcMint: the alias mirrors the asset mint and decimals.
		assert.equal(tgbp.usdcMint, "TGBP111")
		assert.equal(tgbp.usdcDecimals, 7)
		assert.equal(tgbp.label, "L")

		const legacy = parseSolanaIntent({ usdcMint: "USDC111", usdcDecimals: 6 })
		assert.equal(legacy.asset, "USDC")
		assert.equal(legacy.mint, "USDC111")
		assert.equal(legacy.decimals, 6)
		assert.equal(legacy.paymentId, "")
		assert.equal(legacy.cluster, "devnet")
		assert.equal(legacy.amount, "")
		assert.equal(legacy.explorerTxUrlTemplate, "")
	})

	test("re-exports preferredAssetFromConfig", () => {
		assert.equal(
			preferredAssetFromConfig(undefined, { mint: "m", decimals: 6 }).asset,
			"USDC",
		)
	})

	test("getSolanaConfig / getSolanaIntent: success and error envelopes", async () => {
		stubFetch(200, { usdcMint: "U", usdcDecimals: 6 })
		assert.equal((await getSolanaConfig()).assets[0]?.mint, "U")
		stubFetch(503, { code: "solana_not_configured", message: "Off" })
		const off = await caught<ApiError>(getSolanaConfig())
		assert.equal(off.code, "solana_not_configured")
		assert.equal(off.message, "Off")
		stubFetch(500)
		const blank = await caught<ApiError>(getSolanaConfig())
		assert.equal(blank.code, "http_error")
		assert.equal(blank.message, "Solana config failed")

		stubFetch(200, { paymentId: "p 1", amount: "5" })
		assert.equal((await getSolanaIntent("p 1")).amount, "5")
		assert.equal(calls.at(-1)?.url, "/v1/payments/p%201/solana/intent")
		stubFetch(409)
		const intent = await caught<ApiError>(getSolanaIntent("p"))
		assert.equal(intent.status, 409)
		assert.equal(intent.message, "Solana intent failed")
	})

	test("confirmSolanaTransfer: paid, pending (202), error and not-paid", async () => {
		const ok = {
			paymentId: "p",
			paymentStatus: "paid",
			signature: "sig",
			explorerUrl: "x",
			verifiedAt: "now",
			cluster: "devnet",
		}
		stubFetch(200, ok)
		assert.deepEqual(await confirmSolanaTransfer("p", "sig", "idem"), ok)
		const init = calls[0]?.init
		assert.equal(init?.method, "POST")
		assert.equal(
			(init?.headers as Record<string, string>)["Idempotency-Key"],
			"idem",
		)
		assert.equal(init?.body, JSON.stringify({ signature: "sig" }))

		stubFetch(202, { status: "pending" })
		const pending = await caught<ApiError>(confirmSolanaTransfer("p", "s", "i"))
		assert.equal(pending.code, "pending")
		assert.equal(pending.status, 202)

		stubFetch(422, { code: "transfer_mismatch", message: "Wrong amount" })
		const mismatch = await caught<ApiError>(
			confirmSolanaTransfer("p", "s", "i"),
		)
		assert.equal(mismatch.code, "transfer_mismatch")
		stubFetch(400)
		assert.equal(
			(await caught<ApiError>(confirmSolanaTransfer("p", "s", "i"))).message,
			"Solana confirm failed",
		)

		stubFetch(200, { ...ok, paymentStatus: "processing" })
		const notPaid = await caught<ApiError>(confirmSolanaTransfer("p", "s", "i"))
		assert.equal(notPaid.code, "internal_error")
		assert.equal(notPaid.status, 502)
	})
})
