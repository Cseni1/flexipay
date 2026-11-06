import assert from "node:assert/strict"
import { describe, test } from "vitest"
import {
	EMPTY_BANK_DETAILS,
	bankDetailsPayload,
	bankEndpointLabel,
	friendlyPayoutLegError,
} from "../src/payments/bankDetails.ts"

describe("bankDetails", () => {
	test("payload keeps accountNumber and drops blank optionals", () => {
		assert.deepEqual(
			bankDetailsPayload({
				...EMPTY_BANK_DETAILS,
				accountNumber: " 12345678903210 ",
				bankName: "BDO",
				swiftCode: "",
				iban: "  ",
			}),
			{
				accountNumber: "12345678903210",
				bankName: "BDO",
			},
		)
	})

	test("endpoint label uses bank name and last four of the (masked) account", () => {
		assert.equal(
			bankEndpointLabel({
				accountNumber: "********3210",
				bankName: "BDO",
			}),
			"BDO ••3210",
		)
		assert.equal(
			bankEndpointLabel({ accountNumber: "********3210" }),
			"Bank ••3210",
		)
		assert.equal(
			bankEndpointLabel({
				accountNumber: "********3210",
				bankName: "****",
			}),
			"Bank ••3210",
		)
	})

	test("friendly payout error lists missing bank fields in plain English", () => {
		assert.equal(
			friendlyPayoutLegError(
				"Tazapay beneficiary for endpoint ep_1 is missing bankName, swiftCode; required_bank_fields: bank_name",
			),
			"The bank needs: Bank name, SWIFT/BIC",
		)
		assert.equal(
			friendlyPayoutLegError(
				"Tazapay beneficiary for endpoint ep_1 is missing swiftCode; required_bank_codes: swift_code",
			),
			"The bank needs: SWIFT/BIC",
		)
		assert.equal(friendlyPayoutLegError("provider timed out"), null)
	})
})
