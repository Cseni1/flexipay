import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import {
	maskAddress,
	maskPath,
	maskValue,
	readVaultEvidence,
} from "../../scripts/demo/lib/env.ts"
import {
	probeRoutes,
	routeGaps,
	routeProbePath,
	type ApiContract,
} from "../../scripts/demo/lib/preflight.ts"

afterEach(() => {
	vi.unstubAllGlobals()
})

// Prerequisite and privacy helpers: a missing route must be reported as a gap, a mounted route
// that rejects the needed method must not be called missing, and a claim token or wallet address
// must never be printed in full.

const QUOTE = { method: "POST", path: "/v1/quotes", purpose: "quote" } as const
const PAYMENT = {
	method: "GET",
	path: "/v1/payments/{id}",
	purpose: "payment",
} as const

const json = (
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	})

const options = (status: number, allow?: string, body?: unknown) => {
	const headers: Record<string, string> = {}
	if (allow) headers.allow = allow
	return body === undefined
		? new Response(null, { status, headers })
		: json(status, body, headers)
}

const stub = (...responses: Response[]) => {
	const mock = vi.fn(async () => responses.shift() ?? options(404))
	vi.stubGlobal("fetch", mock)
	return mock
}

describe("route preflight", () => {
	const contract: ApiContract = {
		paths: {
			"/v1/quotes": { post: {} },
			"/v1/payments/{id}": { get: {} },
		},
	}

	it("reports only the routes the contract does not carry", () => {
		const gaps = routeGaps(contract, [
			QUOTE,
			PAYMENT,
			{ method: "POST", path: "/v1/claims/{token}/accept", purpose: "accept" },
		])
		expect(gaps.map((gap) => gap.path)).toEqual(["/v1/claims/{token}/accept"])
	})

	it("treats a missing method as missing", () => {
		expect(
			routeGaps(contract, [
				{ method: "GET", path: "/v1/quotes", purpose: "quote" },
			]),
		).toHaveLength(1)
	})
})

describe("runtime route probe", () => {
	it("turns a parameterised path into a concrete OPTIONS target", () => {
		expect(routeProbePath("/v1/payments/{id}/fund")).toBe(
			"/v1/payments/probe/fund",
		)
	})

	it("reports a route the API's catch-all answers for", async () => {
		stub(
			options(404, undefined, { code: "not_found", message: "No such route" }),
			options(404, undefined, { code: "not_found", message: "No such route" }),
		)
		const probe = await probeRoutes(
			"http://127.0.0.1:1",
			[QUOTE, PAYMENT],
			1_000,
		)
		expect(probe.missing.map((gap) => gap.path)).toEqual([
			"/v1/quotes",
			"/v1/payments/{id}",
		])
		expect(probe.methodMismatches).toEqual([])
	})

	it("accepts a mounted route whose Allow header names the needed method", async () => {
		stub(options(200, "POST"), options(200, "GET, HEAD"))
		const probe = await probeRoutes(
			"http://127.0.0.1:1",
			[QUOTE, PAYMENT],
			1_000,
		)
		expect(probe.missing).toEqual([])
		expect(probe.methodMismatches).toEqual([])
	})

	it("separates a mounted path that rejects the method from a missing route", async () => {
		stub(options(200, "GET, HEAD"))
		const probe = await probeRoutes("http://127.0.0.1:1", [QUOTE], 1_000)
		expect(probe.missing).toEqual([])
		expect(probe.methodMismatches).toEqual([
			{ need: QUOTE, allow: ["GET", "HEAD"] },
		])
	})

	it("does not call a route missing for auth, method or application errors", async () => {
		for (const response of [
			options(401, undefined, {
				code: "unauthorized",
				message: "Send an API key",
			}),
			options(403, undefined, { code: "forbidden" }),
			options(405, "GET", { code: "method_not_allowed" }),
			options(500, undefined, { code: "internal_error" }),
			// an application-level 404 after the route matched, e.g. an unknown payment id
			options(404, "GET", { code: "payment_not_found" }),
		]) {
			stub(response)
			const probe = await probeRoutes("http://127.0.0.1:1", [PAYMENT], 1_000)
			expect(probe.missing, JSON.stringify(response)).toEqual([])
		}
	})

	it("treats a 404 that still advertises a method as mounted", async () => {
		stub(options(404, "GET, HEAD", { code: "not_found" }))
		const probe = await probeRoutes("http://127.0.0.1:1", [PAYMENT], 1_000)
		expect(probe.missing).toEqual([])
		expect(probe.methodMismatches).toEqual([])
	})

	it("confirms a GET route when a proxy answers OPTIONS without Allow", async () => {
		stub(options(204), options(401, undefined, { code: "unauthorized" }))
		const probe = await probeRoutes("http://127.0.0.1:1", [PAYMENT], 1_000)
		expect(probe.missing).toEqual([])
	})

	it("does not claim a route is missing when a proxy hides the method list", async () => {
		stub(options(204))
		const probe = await probeRoutes("http://127.0.0.1:1", [QUOTE], 1_000)
		expect(probe.missing).toEqual([])
		expect(probe.methodMismatches).toEqual([])
	})

	it("does not treat a generic 404 as proof the route is absent", async () => {
		for (const body of [undefined, { code: "not_found" }]) {
			stub(options(404, undefined, body))
			const probe = await probeRoutes("http://127.0.0.1:1", [QUOTE], 1_000)
			expect(probe.missing, JSON.stringify(body)).toEqual([])
		}
	})

	it("confirms a missing GET route from the catch-all on a safe GET probe", async () => {
		stub(
			options(204),
			options(404, undefined, { code: "not_found", message: "No such route" }),
		)
		const probe = await probeRoutes("http://127.0.0.1:1", [PAYMENT], 1_000)
		expect(probe.missing.map((gap) => gap.path)).toEqual(["/v1/payments/{id}"])
	})

	it("skips the probe when the API is unreachable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed")
			}),
		)
		const probe = await probeRoutes("http://127.0.0.1:1", [QUOTE], 1_000)
		expect(probe).toEqual({ missing: [], methodMismatches: [] })
	})
})

describe("vault fee evidence", () => {
	const dir = mkdtempSync(join(tmpdir(), "flexipay-ids-"))
	afterAll(() => rmSync(dir, { recursive: true, force: true }))

	it("reads the deployed vault id and fee from existing public evidence", () => {
		const file = join(dir, "ids.env")
		writeFileSync(file, 'FP_PAYOUT_VAULT_ID="CVAULT"\nFP_VAULT_FEE_BPS=100\n')
		expect(readVaultEvidence(file)).toEqual({
			ok: true,
			evidence: { vaultId: "CVAULT", feeBps: 100, source: file },
		})
	})

	it("refuses absent or out-of-range fee evidence instead of defaulting", () => {
		expect(readVaultEvidence(join(dir, "missing.env")).ok).toBe(false)
		const file = join(dir, "bad.env")
		writeFileSync(file, "FP_PAYOUT_VAULT_ID=CVAULT\nFP_VAULT_FEE_BPS=2000\n")
		expect(readVaultEvidence(file)).toMatchObject({
			ok: false,
			problem: /0\.\.1000/,
		})
	})
})

describe("masking", () => {
	it("never prints a claim token or a full address", () => {
		expect(maskPath("/v1/claims/abc123token/accept")).toBe(
			"/v1/claims/{token}/accept",
		)
		expect(maskValue("fp_test_0123456789abcdef")).not.toContain(
			"0123456789abcdef",
		)
		expect(maskAddress("GDEMO1234567890ABCDEF")).toBe("GDEMO…CDEF")
	})
})
