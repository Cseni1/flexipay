import { beforeEach, describe, expect, it } from "vitest"
import { money } from "@flexipay/domain"
import type { SimProviders } from "../src/index.ts"
import {
	adapterOf,
	codeOfAsync,
	collectLeg,
	convertLeg,
	endpointFor,
	fresh,
	payoutLeg,
	row,
} from "./helpers.ts"

const US = "sim_bank_us_ach"
const PH_BANK = "sim_bank_ph_instapay"
const FX = "sim_fx"

let sim: SimProviders

beforeEach(() => {
	sim = fresh()
})

const usd = (amount: string) => money(amount, "USD")

describe("execute replay (CCR-4 §4)", () => {
	it("returns the same reference for the same leg and attempt", async () => {
		const adapter = adapterOf(sim, US)
		const first = await adapter.execute(collectLeg(usd("100000")))
		const replay = await adapter.execute(collectLeg(usd("100000")))

		expect(replay.externalRef).toBe(first.externalRef)
		expect(await adapter.status(first.externalRef)).toMatchObject({
			status: "succeeded",
		})
	})

	it("never revives a failed execution", async () => {
		const adapter = adapterOf(sim, US)
		sim.controls.failNext(US, 1)

		const first = await adapter.execute(collectLeg(usd("100000")))
		expect(await adapter.status(first.externalRef)).toMatchObject({
			status: "failed",
		})

		const replay = await adapter.execute(collectLeg(usd("100000")))
		expect(replay.externalRef).toBe(first.externalRef)
		expect(await adapter.status(first.externalRef)).toMatchObject({
			status: "failed",
			error: { code: "sandbox_forced_failure" },
		})
	})

	it("gives a retry attempt its own reference", async () => {
		const adapter = adapterOf(sim, US)
		sim.controls.failNext(US, 1)

		const first = await adapter.execute(collectLeg(usd("100000")))
		const retry = await adapter.execute(
			collectLeg(usd("100000"), { attempt: 2 }),
		)

		expect(retry.externalRef).not.toBe(first.externalRef)
		expect(await adapter.status(retry.externalRef)).toMatchObject({
			status: "succeeded",
		})
		expect(await adapter.status(first.externalRef)).toMatchObject({
			status: "failed",
		})
	})

	it("never revives a reversed execution", async () => {
		const adapter = adapterOf(sim, US)
		const first = await adapter.execute(collectLeg(usd("100000")))
		const reversal = await adapter.reverse(first.externalRef)

		const replay = await adapter.execute(collectLeg(usd("100000")))
		expect(replay.externalRef).toBe(first.externalRef)
		expect(await adapter.status(first.externalRef)).toMatchObject({
			status: "succeeded",
		})
		expect((await adapter.reverse(first.externalRef)).externalRef).toBe(
			reversal.externalRef,
		)
	})
})

describe("reverse (CCR-4 §4)", () => {
	it("reverses a succeeded collect leg and is idempotent", async () => {
		const adapter = adapterOf(sim, US)
		const { externalRef } = await adapter.execute(collectLeg(usd("100000")))

		const first = await adapter.reverse(externalRef)
		expect(first.externalRef).not.toBe(externalRef)
		expect(await adapter.status(first.externalRef)).toMatchObject({
			status: "succeeded",
		})

		const again = await adapter.reverse(externalRef)
		expect(again.externalRef).toBe(first.externalRef)
	})

	it("reverses a succeeded convert leg", async () => {
		const adapter = adapterOf(sim, FX)
		const { externalRef } = await adapter.execute(
			convertLeg(usd("100000"), "USDC"),
		)
		const reversal = await adapter.reverse(externalRef)
		expect(reversal.externalRef).not.toBe(externalRef)
	})

	it("refuses to reverse a payout", async () => {
		const ph = row(PH_BANK)
		const adapter = adapterOf(sim, PH_BANK)
		const { externalRef } = await adapter.execute(
			payoutLeg(ph, money("50000", "PHP")),
		)
		expect(await codeOfAsync(adapter.reverse(externalRef))).toBe(
			"not_reversible",
		)
	})

	it("refuses to reverse a leg that did not succeed", async () => {
		const adapter = adapterOf(sim, US)
		sim.controls.failNext(US, 1)
		const { externalRef } = await adapter.execute(collectLeg(usd("100000")))
		expect(await codeOfAsync(adapter.reverse(externalRef))).toBe(
			"not_succeeded",
		)
	})

	it("rejects a reference it never issued", async () => {
		const adapter = adapterOf(sim, US)
		expect(await codeOfAsync(adapter.status("nope"))).toBe("unknown_reference")
		expect(await codeOfAsync(adapter.reverse("nope"))).toBe("unknown_reference")
	})
})

describe("request validation", () => {
	it("rejects a leg kind the provider does not serve", async () => {
		expect(
			await codeOfAsync(
				adapterOf(sim, US).quote({
					kind: "convert",
					amountIn: usd("100000"),
					outCurrency: "PHP",
				}),
			),
		).toBe("unsupported")
		expect(
			await codeOfAsync(
				adapterOf(sim, FX).execute(
					payoutLeg(row(PH_BANK), money("50000", "PHP")),
				),
			),
		).toBe("unsupported")
	})

	it("requires a destination the provider serves for a payout", async () => {
		const wallet = row("sim_ewallet_ph")
		expect(
			await codeOfAsync(
				adapterOf(sim, wallet.id).quote({
					kind: "payout",
					amountIn: money("50000", "PHP"),
					outCurrency: "PHP",
				}),
			),
		).toBe("unsupported")

		expect(
			await codeOfAsync(
				adapterOf(sim, wallet.id).quote({
					kind: "payout",
					amountIn: money("50000", "PHP"),
					outCurrency: "PHP",
					endpoint: endpointFor(row(PH_BANK)),
				}),
			),
		).toBe("unsupported")

		expect(
			await codeOfAsync(
				adapterOf(sim, PH_BANK).quote({
					kind: "payout",
					amountIn: money("50000", "PHP"),
					outCurrency: "PHP",
					endpoint: { ...endpointFor(row(PH_BANK)), currency: "USD" },
				}),
			),
		).toBe("currency_mismatch")
	})
})
