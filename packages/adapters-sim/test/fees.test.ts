import { describe, expect, it } from "vitest"
import { money } from "@flexipay/domain"
import { createSimProviders } from "../src/index.ts"
import {
	adapterOf,
	codeOfAsync,
	config,
	fresh,
	payoutLeg,
	payoutRequest,
	row,
} from "./helpers.ts"

const PH_BANK = "sim_bank_ph_instapay"
const PH_WALLET = "sim_ewallet_ph"
const FX = "sim_fx"

describe("fees (CCR-4 §3)", () => {
	it("adds the fixed fee to the proportional fee in the input currency", async () => {
		const ph = row(PH_BANK)
		const quote = await adapterOf(fresh(), PH_BANK).quote(
			payoutRequest(ph, money("5000", "PHP")),
		)

		// 5000 PHP at 50 bps is 25; the fixed fee is 1500 PHP.
		expect(quote.fee).toEqual(money("1525", "PHP"))
		expect(quote.amountOut).toEqual(money("3475", "PHP"))
		expect(quote.fxRate).toBeNull()
		expect(quote.estimatedTimeSeconds).toBe(ph.estimatedTimeSeconds)
	})

	it("accepts a zero fixed fee whatever currency it is written in", async () => {
		// sim_fx charges 0 USD, yet this leg's input is USDC.
		const quote = await adapterOf(fresh(), FX).quote({
			kind: "convert",
			amountIn: money("1000000000", "USDC"),
			outCurrency: "PHP",
		})
		expect(quote.fee.currency).toBe("USDC")
		expect(quote.fee).toEqual(money("2500000", "USDC"))
	})

	it("rejects a nonzero fixed fee written in another currency", async () => {
		// A row that serves the input currency but charges its fixed fee in a different one.
		const cloned = structuredClone(config)
		const target = cloned.providers.find((p) => p.id === PH_BANK)!
		target.currencies.push("USD")
		target.limits = null
		const sim = createSimProviders(cloned)

		expect(
			await codeOfAsync(
				adapterOf(sim, PH_BANK).quote({
					kind: "payout",
					amountIn: money("5000", "USD"),
					outCurrency: "USD",
					endpoint: {
						endpointId: "ep_usd",
						type: "bank_account",
						country: "PH",
						currency: "USD",
					},
				}),
			),
		).toBe("currency_mismatch")
	})

	it("rejects a fee that would consume the input", async () => {
		// The e-wallet's placeholder fixed fee (1000 PHP) equals its configured minimum.
		const adapter = adapterOf(fresh(), PH_WALLET)
		await expect(
			adapter.quote(payoutRequest(row(PH_WALLET), money("1000", "PHP"))),
		).rejects.toMatchObject({ code: "fee_exceeds_amount" })
		expect(
			await codeOfAsync(
				adapter.execute(payoutLeg(row(PH_WALLET), money("1000", "PHP"))),
			),
		).toBe("fee_exceeds_amount")
	})
})

describe("limits (CCR-4 §3)", () => {
	it("compares the input amount against min and max", async () => {
		const adapter = adapterOf(fresh(), PH_WALLET)
		await expect(
			adapter.quote(payoutRequest(row(PH_WALLET), money("999", "PHP"))),
		).rejects.toMatchObject({ code: "below_min" })

		await expect(
			adapterOf(fresh(), PH_BANK).quote(
				payoutRequest(row(PH_BANK), money("5000001", "PHP")),
			),
		).rejects.toMatchObject({ code: "above_max" })
	})

	it("applies no limit when the provider has none", async () => {
		const quote = await adapterOf(fresh(), FX).quote({
			kind: "convert",
			amountIn: money("999999999999999", "USDC"),
			outCurrency: "PHP",
		})
		expect(quote.amountOut.currency).toBe("PHP")
	})
})
