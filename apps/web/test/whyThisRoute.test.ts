import assert from "node:assert/strict"
import { type Quote } from "@flexipay/web-lib/contract"
import { describe, test } from "vitest"
import {
	buildWhyThisRoute,
	providerBadge,
	providerLabel,
} from "../src/payments/whyThisRoute.ts"

const leg = (
	kind: "collect" | "convert" | "settle" | "payout",
	providerId: string,
	amountOut: string,
	currency: string,
	simulated = true,
) => ({
	kind,
	rail: providerId,
	providerId,
	amountIn: { amount: amountOut, currency },
	amountOut: { amount: amountOut, currency },
	simulated,
})

describe("whyThisRoute", () => {
	test("labels providers and badges", () => {
		assert.equal(providerLabel("sim_ewallet_ph"), "Ewallet Ph")
		assert.equal(providerBadge(true), "Simulated")
		assert.equal(providerBadge(false), "Sandbox")
	})

	test("builds per-leg sentences with alternatives", () => {
		const quote = {
			route: [
				leg("collect", "sim_bank_us_ach", "125000", "USD"),
				leg("payout", "sim_ewallet_ph", "6625000", "PHP"),
			],
			alternatives: [
				{
					route: [
						leg("collect", "sim_bank_us_ach", "125000", "USD"),
						leg("payout", "blindpay_ph", "6500000", "PHP", false),
					],
					totalCost: { amount: "100", currency: "USD" },
					estimatedTimeSeconds: 60,
					reasons: [],
				},
			],
			reasons: ["cheapest_total"],
		} as unknown as Quote

		const lines = buildWhyThisRoute(quote)
		assert.equal(lines.length, 2)
		assert.match(lines[1]!.sentence, /Payout: Ewallet Ph delivers/)
		assert.match(lines[1]!.sentence, /others: Blindpay Ph/)
		assert.equal(lines[1]!.chosenBadge, "Simulated")
		assert.equal(lines[1]!.others[0]?.badge, "Sandbox")
	})
})
