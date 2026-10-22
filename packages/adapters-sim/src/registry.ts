import type {
	FlexiPayConfig,
	ProviderAdapter,
	SandboxControls,
} from "@flexipay/domain"
import {
	newOverride,
	SimSandboxControls,
	type ProviderOverride,
} from "./overrides.ts"
import { SimProviderAdapter } from "./sim-provider.ts"

/** The adapters plus the sandbox controls that drive them (CCR-4 §1). */
export interface SimProviders {
	providers: Map<string, ProviderAdapter>
	controls: SandboxControls
}

/**
 * Builds one adapter per simulated provider row in the validated config, keyed by id, with its own
 * override state. Only rows flagged `simulated: true` are built; a real provider (the anchor,
 * later) is not this package's job. Every capability comes from the row, so config remains the only
 * source of countries, currencies, endpoint types, leg kinds, limits, fees, spreads, rates and
 * times.
 */
export function createSimProviders(config: FlexiPayConfig): SimProviders {
	const overrides = new Map<string, ProviderOverride>()
	const providers = new Map<string, ProviderAdapter>()

	for (const row of config.providers) {
		if (!row.simulated) continue
		const override = newOverride()
		overrides.set(row.id, override)
		providers.set(row.id, new SimProviderAdapter(row, config.fxRates, override))
	}

	return { providers, controls: new SimSandboxControls(overrides) }
}
