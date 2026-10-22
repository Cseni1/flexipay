import { beforeEach, describe, expect, it } from "vitest"
import { money } from "@flexipay/domain"
import type { SimProviders } from "../src/index.ts"
import {
	adapterOf,
	codeOf,
	collectLeg,
	fresh,
	payoutLeg,
	row,
} from "./helpers.ts"

const US = "sim_bank_us_ach"
const PH = "sim_bank_ph_instapay"

let sim: SimProviders

beforeEach(() => {
	sim = fresh()
})

describe("sandbox controls", () => {
	it("fails exactly the next count executions, then runs normally", async () => {
		const adapter = adapterOf(sim, US)
		sim.controls.failNext(US, 2)

		const first = await adapter.execute(collectLeg(money("100000", "USD")))
		expect(await adapter.status(first.externalRef)).toMatchObject({
			status: "failed",
			error: { code: "sandbox_forced_failure" },
		})

		const second = await adapter.execute(
			collectLeg(money("100000", "USD"), { legId: "leg_2", attempt: 1 }),
		)
		expect(await adapter.status(second.externalRef)).toMatchObject({
			status: "failed",
		})

		const third = await adapter.execute(
			collectLeg(money("100000", "USD"), { legId: "leg_3", attempt: 1 }),
		)
		expect(await adapter.status(third.externalRef)).toMatchObject({
			status: "succeeded",
		})
	})

	it("defaults failNext to one execution", async () => {
		const adapter = adapterOf(sim, US)
		sim.controls.failNext(US)

		const first = await adapter.execute(collectLeg(money("100000", "USD")))
		expect(await adapter.status(first.externalRef)).toMatchObject({
			status: "failed",
		})
		const second = await adapter.execute(
			collectLeg(money("100000", "USD"), { legId: "leg_2", attempt: 1 }),
		)
		expect(await adapter.status(second.externalRef)).toMatchObject({
			status: "succeeded",
		})
	})

	it("fails every execution while a forced failure is on", async () => {
		const adapter = adapterOf(sim, US)
		sim.controls.setForcedFailure(US, true)

		for (const legId of ["leg_1", "leg_2"]) {
			const { externalRef } = await adapter.execute(
				collectLeg(money("100000", "USD"), { legId, attempt: 1 }),
			)
			expect(await adapter.status(externalRef)).toMatchObject({
				status: "failed",
				error: { code: "sandbox_forced_failure" },
			})
		}

		sim.controls.setForcedFailure(US, false)
		const after = await adapter.execute(
			collectLeg(money("100000", "USD"), { legId: "leg_3", attempt: 1 }),
		)
		expect(await adapter.status(after.externalRef)).toMatchObject({
			status: "succeeded",
		})
	})

	it("marks a provider down and fails a leg that runs while down", async () => {
		const adapter = adapterOf(sim, US)
		sim.controls.setHealth(US, "down")
		expect(await adapter.health()).toBe("down")

		const { externalRef } = await adapter.execute(
			collectLeg(money("100000", "USD")),
		)
		expect(await adapter.status(externalRef)).toMatchObject({
			status: "failed",
			error: { code: "provider_down" },
		})

		sim.controls.setHealth(US, "up")
		expect(await adapter.health()).toBe("up")
		const after = await adapter.execute(
			collectLeg(money("100000", "USD"), { legId: "leg_2", attempt: 1 }),
		)
		expect(await adapter.status(after.externalRef)).toMatchObject({
			status: "succeeded",
		})
	})

	it("clears every override on reset", async () => {
		const adapter = adapterOf(sim, US)
		sim.controls.failNext(US, 5)
		sim.controls.setForcedFailure(US, true)
		sim.controls.setHealth(US, "down")

		sim.controls.reset()

		expect(await adapter.health()).toBe("up")
		const { externalRef } = await adapter.execute(
			collectLeg(money("100000", "USD")),
		)
		expect(await adapter.status(externalRef)).toMatchObject({
			status: "succeeded",
		})
	})

	it("keeps overrides per provider", async () => {
		sim.controls.failNext(US, 1)
		sim.controls.setHealth(PH, "down")

		const us = await adapterOf(sim, US).execute(
			collectLeg(money("100000", "USD")),
		)
		expect(await adapterOf(sim, US).status(us.externalRef)).toMatchObject({
			status: "failed",
		})
		expect(await adapterOf(sim, PH).health()).toBe("down")

		const ph = await adapterOf(sim, PH).execute(
			payoutLeg(row(PH), money("50000", "PHP")),
		)
		expect(await adapterOf(sim, PH).status(ph.externalRef)).toMatchObject({
			status: "failed",
			error: { code: "provider_down" },
		})
	})

	it("keeps registry state isolated", async () => {
		sim.controls.setForcedFailure(US, true)
		const other = fresh()

		const failing = await adapterOf(sim, US).execute(
			collectLeg(money("100000", "USD")),
		)
		const healthy = await adapterOf(other, US).execute(
			collectLeg(money("100000", "USD")),
		)

		expect(await adapterOf(sim, US).status(failing.externalRef)).toMatchObject({
			status: "failed",
		})
		expect(
			await adapterOf(other, US).status(healthy.externalRef),
		).toMatchObject({ status: "succeeded" })
		expect(await adapterOf(other, US).health()).toBe("up")
	})

	it("rejects an unknown provider and an impossible count", () => {
		expect(codeOf(() => sim.controls.failNext("sim_nope"))).toBe("unsupported")
		expect(codeOf(() => sim.controls.setForcedFailure("sim_nope", true))).toBe(
			"unsupported",
		)
		expect(codeOf(() => sim.controls.setHealth("sim_nope", "down"))).toBe(
			"unsupported",
		)
		expect(codeOf(() => sim.controls.failNext(US, -1))).toBe("unsupported")
		expect(codeOf(() => sim.controls.failNext(US, 1.5))).toBe("unsupported")
	})

	it("returns a reference and a message with the failure code", async () => {
		const adapter = adapterOf(sim, US)
		sim.controls.failNext(US, 1)
		const { externalRef } = await adapter.execute(
			collectLeg(money("100000", "USD")),
		)

		const state = await adapter.status(externalRef)
		expect(state.externalRef).toBe(externalRef)
		expect(state.error?.message.length).toBeGreaterThan(0)
	})
})
