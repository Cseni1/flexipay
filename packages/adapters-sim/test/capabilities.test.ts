import { describe, expect, it } from "vitest"
import { adapterOf, config, fresh, row } from "./helpers.ts"

const SF1_PROVIDERS = [
	"sim_bank_br_pix",
	"sim_bank_ph_instapay",
	"sim_bank_us_ach",
	"sim_bank_za_eft",
	"sim_ewallet_ph",
	"sim_fx",
]

describe("the six simulated providers", () => {
	it("builds exactly the six baseline providers from config", () => {
		const sim = fresh()
		expect([...sim.providers.keys()].sort()).toEqual(SF1_PROVIDERS)
		expect(sim.providers.size).toBe(6)
	})

	it("reports the config's capabilities, unchanged", () => {
		const sim = fresh()
		for (const configRow of config.providers) {
			expect(adapterOf(sim, configRow.id).capabilities()).toEqual({
				providerId: configRow.id,
				countries: configRow.countries,
				currencies: configRow.currencies,
				endpointTypes: configRow.endpointTypes,
				legKinds: configRow.legKinds,
				limits: configRow.limits,
				simulated: true,
			})
		}
	})

	it("starts healthy, simulated and untriggered", async () => {
		const sim = fresh()
		for (const adapter of sim.providers.values()) {
			expect(await adapter.health()).toBe("up")
			expect(adapter.capabilities().simulated).toBe(true)
		}
	})

	it("keeps endpoint types and leg kinds distinct on the FX provider", () => {
		const fx = adapterOf(fresh(), "sim_fx").capabilities()
		expect(fx.legKinds).toEqual(["convert"])
		expect(fx.endpointTypes).toEqual([])
		// FX has no limit of its own: the corridor's send-side limit applies (CCR-3).
		expect(fx.limits).toBeNull()
		expect(row("sim_fx").limits).toBeNull()
	})

	it("keeps provider limits in the provider's own currency", () => {
		const sim = fresh()
		for (const configRow of config.providers) {
			if (!configRow.limits) continue
			expect(configRow.limits.min.currency).toBe(configRow.currencies[0])
			expect(configRow.limits.max.currency).toBe(configRow.currencies[0])
			expect(adapterOf(sim, configRow.id).capabilities().limits).toEqual(
				configRow.limits,
			)
		}
	})
})
