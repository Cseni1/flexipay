import assert from "node:assert/strict"
import { type Quote } from "@flexipay/web-lib/contract"
import { describe, test } from "vitest"
import {
	computeAggregatorSaving,
	formatPaymentSavingLine,
	formatQuoteSavingLine,
	sumSavingsByCurrency,
} from "../src/payments/aggregatorSaving.ts"

const leg = (
	kind: "collect" | "convert" | "settle" | "payout",
	providerId: string,
	amountOut: string,
	currency: string,
) => ({
	kind,
	rail: providerId,
	providerId,
	amountIn: { amount: amountOut, currency },
	amountOut: { amount: amountOut, currency },
	simulated: true,
})

describe("computeAggregatorSaving", () => {
	test("shows the receive advantage vs the best same-currency alternative", () => {
		const quote = {
			expectedReceive: { amount: "6625000", currency: "PHP" },
			alternatives: [
				{
					route: [
						leg("collect", "sim_bank_us_ach", "125000", "USD"),
						leg("payout", "blindpay_sandbox", "6500000", "PHP"),
					],
					totalCost: { amount: "4000", currency: "USD" },
					estimatedTimeSeconds: 60,
					reasons: [],
				},
			],
		} as unknown as Quote

		const saving = computeAggregatorSaving(quote)
		assert.deepEqual(saving, {
			amount: "125000",
			currency: "PHP",
			nextBestLabel: "BlindPay",
		})
		assert.match(formatQuoteSavingLine(saving!), /1,250\.00 PHP/)
		assert.match(formatQuoteSavingLine(saving!), /BlindPay/)
		assert.equal(
			formatPaymentSavingLine(saving!),
			"Saved 1,250.00 PHP vs next best",
		)
	})

	test("hides when there is no alternative or the difference is zero", () => {
		assert.equal(
			computeAggregatorSaving({
				expectedReceive: { amount: "6625000", currency: "PHP" },
				alternatives: [],
			}),
			null,
		)

		const equal = computeAggregatorSaving({
			expectedReceive: { amount: "6625000", currency: "PHP" },
			alternatives: [
				{
					route: [leg("payout", "blindpay_sandbox", "6625000", "PHP")],
					totalCost: { amount: "4000", currency: "USD" },
					estimatedTimeSeconds: 60,
					reasons: [],
				},
			],
		} as unknown as Parameters<typeof computeAggregatorSaving>[0])
		assert.equal(equal, null)
	})

	test("ignores alternatives whose last leg is a different currency", () => {
		assert.equal(
			computeAggregatorSaving({
				expectedReceive: { amount: "6625000", currency: "PHP" },
				alternatives: [
					{
						route: [leg("payout", "sim_bank_ph_instapay", "125000", "USD")],
						totalCost: { amount: "4000", currency: "USD" },
						estimatedTimeSeconds: 60,
						reasons: [],
					},
				],
			} as unknown as Parameters<typeof computeAggregatorSaving>[0]),
			null,
		)
	})

	test("sums savings per currency", () => {
		const totals = sumSavingsByCurrency([
			{ amount: "125000", currency: "PHP", nextBestLabel: "A" },
			{ amount: "50000", currency: "PHP", nextBestLabel: "B" },
			{ amount: "100", currency: "USD", nextBestLabel: "C" },
		])
		assert.deepEqual(
			totals.map((t) => ({ amount: t.amount, currency: t.currency })),
			[
				{ amount: "175000", currency: "PHP" },
				{ amount: "100", currency: "USD" },
			],
		)
	})
})
