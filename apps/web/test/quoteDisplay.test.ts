import assert from "node:assert/strict"
import { describe, test } from "vitest"
import {
	displayFeesTotal,
	displayMoney,
	formatQuoteReason,
	toPoundPence,
} from "../src/payments/quoteDisplay.ts"

describe("quote display money", () => {
	test("formats GBP and TGBP as pounds", () => {
		assert.equal(displayMoney("10", "GBP"), "£0.10")
		assert.equal(displayMoney("1000", "GBP"), "£10.00")
		assert.equal(displayMoney("1000000", "TGBP"), "£0.10")
		assert.equal(displayMoney("10000000", "TGBP"), "£1.00")
		// Live claim-shaped receive: 99_009_900 at 7dp → £9.90
		assert.equal(displayMoney("99009900", "TGBP"), "£9.90")
	})

	test("leaves USD and USDC on the web-lib formatter", () => {
		assert.equal(displayMoney("125000", "USD"), "1,250.00 USD")
		assert.match(displayMoney("250000000", "USDC"), /USDC/)
	})

	test("All fees counts the settle fee once (flexiPayFee mirrors it), rounded like the line items", () => {
		assert.equal(toPoundPence("1000000", "TGBP"), 10n)
		assert.equal(toPoundPence("9", "GBP"), 9n)

		const fees = {
			legs: [
				{
					kind: "settle" as const,
					rail: "solana_tgbp",
					fee: { amount: "1000000", currency: "TGBP" },
				},
			],
			flexiPayFee: { amount: "1000000", currency: "TGBP" },
			// Floored API total that would incorrectly show £0.09 if used alone.
			total: { amount: "9", currency: "GBP" },
			settleUnlockedRemainder: null,
		}
		assert.equal(displayMoney(fees.total.amount, fees.total.currency), "£0.09")
		assert.equal(displayFeesTotal(fees), "£0.10")
	})

	test("formats unlocked remainder reasons with the asset formatter", () => {
		assert.equal(
			formatQuoteReason(
				"PayerPays settle remainder 10000000 TGBP stays unlocked (not a fee; CCR-8/CCR-13)",
			),
			"PayerPays settle remainder £1.00 stays unlocked (not a fee; CCR-8/CCR-13)",
		)
		assert.match(
			formatQuoteReason(
				"PayerPays settle remainder 10000000 USDC stays unlocked (not a fee; CCR-8/CCR-13)",
			),
			/1(\.0+)?/,
		)
	})
})
