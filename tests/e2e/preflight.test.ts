import { describe, expect, it } from "vitest"
import { maskAddress, maskPath, maskValue } from "../../scripts/demo/lib/env.ts"
import {
	routeGaps,
	type ApiContract,
} from "../../scripts/demo/lib/preflight.ts"

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
