import { afterEach, describe, expect, it, vi } from "vitest"
import { maskAddress, maskPath, maskValue } from "../../scripts/demo/lib/env.ts"
import {
	routeGaps,
	routeProbePath,
	runtimeRouteGaps,
	type ApiContract,
} from "../../scripts/demo/lib/preflight.ts"

afterEach(() => {
	vi.unstubAllGlobals()
})

// Prerequisite and privacy helpers: a missing route must be reported as a gap, and a claim token
// or wallet address must never be printed in full.

describe("route preflight", () => {
	const contract: ApiContract = {
		paths: {
			"/v1/quotes": { post: {} },
			"/v1/payments/{id}": { get: {} },
		},
	}

	it("reports only the routes the contract does not carry", () => {
		const gaps = routeGaps(contract, [
			{ method: "POST", path: "/v1/quotes", purpose: "quote" },
			{ method: "GET", path: "/v1/payments/{id}", purpose: "payment" },
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

	it("reports a published stub the server answers 404 for", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 404 })),
		)
		const gaps = await runtimeRouteGaps(
			"http://127.0.0.1:1",
			[
				{ method: "POST", path: "/v1/quotes", purpose: "quote" },
				{ method: "GET", path: "/v1/payments/{id}", purpose: "payment" },
			],
			1_000,
		)
		expect(gaps.map((gap) => gap.path)).toEqual([
			"/v1/quotes",
			"/v1/payments/{id}",
		])
	})

	it("accepts a route Express answers for OPTIONS", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 200 })),
		)
		expect(
			await runtimeRouteGaps(
				"http://127.0.0.1:1",
				[{ method: "GET", path: "/v1/payments/{id}", purpose: "payment" }],
				1_000,
			),
		).toEqual([])
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
