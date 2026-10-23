import { describe, expect, it } from "vitest"
import { convertMoney, money } from "@flexipay/domain"
import { adapterOf, codeOfAsync, fresh, row } from "./helpers.ts"

const FX = "sim_fx"

describe("FX conversion (CCR-4 §2 and §3)", () => {
	it("converts USD to USDC at the configured rate, after the fee and the spread", async () => {
		const adapter = adapterOf(fresh(), FX)
		const quote = await adapter.quote({
			kind: "convert",
			amountIn: money("100000", "USD"),
			outCurrency: "USDC",
		})

		// 100000 minor USD, fee 25 bps = 250 USD, net 997.50 USD.
		expect(quote.fee).toEqual(money("250", "USD"))
		// 997.50 USDC at rate 1, then 50 bps spread: 992.5125000 USDC (7 decimals).
		expect(quote.amountOut).toEqual(money("9925125000", "USDC"))
		expect(quote.fxRate).toBe("1.0000000")
		expect(quote.simulated).toBe(true)
	})

	it("charges the fee before converting, not after", async () => {
		const adapter = adapterOf(fresh(), FX)
		const quote = await adapter.quote({
			kind: "convert",
			amountIn: money("100000", "USD"),
			outCurrency: "USDC",
		})

		const net = { amount: "99750", currency: "USD" }
		const expected = convertMoney(net, "1.0000000", "USDC")
		expect(quote.amountOut.amount).toBe(
			((BigInt(expected.amount) * 9950n) / 10000n).toString(),
		)
		// Fee-first and fee-last differ by the fee's own spread, so the numbers are distinct.
		const gross = convertMoney(money("100000", "USD"), "1.0000000", "USDC")
		expect(quote.amountOut.amount).not.toBe(
			((BigInt(gross.amount) * 9950n) / 10000n - 250n).toString(),
		)
	})

	it("uses the rate of the direction asked for, with 7-decimal USDC maths", async () => {
		const adapter = adapterOf(fresh(), FX)
		const quote = await adapter.quote({
			kind: "convert",
			amountIn: money("1000000000", "USDC"),
			outCurrency: "PHP",
		})

		// 100 USDC, fee 25 bps = 2.5000000 USDC, net 99.7500000 USDC.
		expect(quote.fee).toEqual(money("2500000", "USDC"))
		expect(quote.fxRate).toBe("56.0000000")
		// 99.75 * 56 = 5586.00 PHP, then 50 bps spread, rounded down: 5558.07 PHP.
		expect(quote.amountOut).toEqual(money("555807", "PHP"))
	})

	it("rounds down on a tiny amount instead of producing a fraction", async () => {
		const adapter = adapterOf(fresh(), FX)
		const quote = await adapter.quote({
			kind: "convert",
			amountIn: money("1", "USD"),
			outCurrency: "USDC",
		})

		expect(quote.fee).toEqual(money("0", "USD"))
		// 0.01 USD = 100000 minor USDC at rate 1; after 50 bps that is 99500, not 99500.5.
		expect(quote.amountOut).toEqual(money("99500", "USDC"))
	})

	it("never derives an inverse rate", async () => {
		const adapter = adapterOf(fresh(), FX)
		// ZAR>USD is configured, but ZAR>PHP is not, so this direction has no rate.
		await expect(
			adapter.quote({
				kind: "convert",
				amountIn: money("100000", "ZAR"),
				outCurrency: "PHP",
			}),
		).rejects.toMatchObject({ code: "no_fx_rate" })
		expect(
			await codeOfAsync(
				adapter.execute({
					kind: "convert",
					amountIn: money("100000", "ZAR"),
					outCurrency: "PHP",
					paymentId: "pay_x",
					legId: "leg_x",
					attempt: 1,
				}),
			),
		).toBe("no_fx_rate")
	})

	it("takes the rates from config, not from the FX provider's currency list", async () => {
		const adapter = adapterOf(fresh(), FX)
		expect(row(FX).currencies).not.toContain("USDC")
		const quote = await adapter.quote({
			kind: "convert",
			amountIn: money("100000", "USD"),
			outCurrency: "USDC",
		})
		expect(quote.amountOut.currency).toBe("USDC")
	})
})
