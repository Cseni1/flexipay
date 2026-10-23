import { test, expect } from "@playwright/test"
import { ClaimAcceptRequestSchema } from "../../../packages/web-lib/claim-contract.ts"
import { buildClaimEndpoint } from "../../../packages/web-lib/claim-endpoint.ts"

// Pure CCR-17 payload checks. The fiat accept route is still blocked on the API, so these
// prove the prepared accountNumber/phoneNumber shapes without sending an unapproved request.

test.describe("CF4 claim endpoint payload", () => {
	test("crypto uses address with empty country and stellar network", () => {
		const endpoint = buildClaimEndpoint({
			type: "crypto_wallet",
			detail: "GDEMOTESTNETADDRESSONLY000000000000000000000000000000000000",
			currency: "USDC",
			country: "PH",
		})

		expect(endpoint).toEqual({
			type: "crypto_wallet",
			country: "",
			currency: "USDC",
			network: "stellar",
			details: {
				address: "GDEMOTESTNETADDRESSONLY000000000000000000000000000000000000",
			},
			simulated: true,
		})
		expect(ClaimAcceptRequestSchema.safeParse({ endpoint }).success).toBe(true)
	})

	test("bank account uses accountNumber and the destination country", () => {
		const endpoint = buildClaimEndpoint({
			type: "bank_account",
			detail: "PH-DEMO-ACCOUNT-1",
			currency: "PHP",
			country: "PH",
		})

		expect(endpoint).toMatchObject({
			type: "bank_account",
			country: "PH",
			currency: "PHP",
			network: null,
			details: { accountNumber: "PH-DEMO-ACCOUNT-1" },
		})
		expect(ClaimAcceptRequestSchema.safeParse({ endpoint }).success).toBe(true)
	})

	test("e-wallet uses phoneNumber and the destination country", () => {
		const endpoint = buildClaimEndpoint({
			type: "ewallet",
			detail: "+63-900-000-0000",
			currency: "PHP",
			country: "PH",
		})

		expect(endpoint).toMatchObject({
			type: "ewallet",
			country: "PH",
			currency: "PHP",
			network: null,
			details: { phoneNumber: "+63-900-000-0000" },
		})
		expect(ClaimAcceptRequestSchema.safeParse({ endpoint }).success).toBe(true)
	})
})
