import { fileURLToPath } from "node:url"
import {
	loadConfig,
	ProviderError,
	type EndpointRef,
	type FlexiPayConfig,
	type LegExecution,
	type LegQuoteRequest,
	type Money,
	type Provider,
	type ProviderAdapter,
} from "@flexipay/domain"
import { createSimProviders, type SimProviders } from "../src/index.ts"

// The tests read the real, validated config: the point is that the six adapters are driven by
// config/providers.json, not by a fixture that could drift away from it.

export const CONFIG_DIR = fileURLToPath(
	new URL("../../../config", import.meta.url),
)

export const config: FlexiPayConfig = await (async () => {
	const result = await loadConfig(CONFIG_DIR)
	if (!result.ok)
		throw new Error(`config invalid: ${JSON.stringify(result.issues)}`)
	return result.config
})()

/** A fresh registry per test, so sandbox state never leaks between them. */
export function fresh(): SimProviders {
	return createSimProviders(config)
}

export function row(id: string): Provider {
	const found = config.providers.find((p) => p.id === id)
	if (!found) throw new Error(`no config row for ${id}`)
	return found
}

export function adapterOf(sim: SimProviders, id: string): ProviderAdapter {
	const adapter = sim.providers.get(id)
	if (!adapter) throw new Error(`no adapter for ${id}`)
	return adapter
}

/** A destination the provider itself serves, built from its own config row. */
export function endpointFor(configRow: Provider): EndpointRef {
	return {
		endpointId: `ep_${configRow.id}`,
		type: configRow.endpointTypes[0],
		country: configRow.countries[0],
		currency: configRow.currencies[0],
	}
}

export function payoutRequest(
	configRow: Provider,
	amountIn: Money,
): LegQuoteRequest {
	return {
		kind: "payout",
		amountIn,
		outCurrency: amountIn.currency,
		endpoint: endpointFor(configRow),
	}
}

export function payoutLeg(
	configRow: Provider,
	amountIn: Money,
	over: Partial<LegExecution> = {},
): LegExecution {
	return {
		...payoutRequest(configRow, amountIn),
		paymentId: "pay_1",
		legId: "leg_1",
		attempt: 1,
		...over,
	}
}

export function collectLeg(
	amountIn: Money,
	over: Partial<LegExecution> = {},
): LegExecution {
	return {
		kind: "collect",
		amountIn,
		outCurrency: amountIn.currency,
		paymentId: "pay_1",
		legId: "leg_c",
		attempt: 1,
		...over,
	}
}

export function convertLeg(
	amountIn: Money,
	to: string,
	over: Partial<LegExecution> = {},
): LegExecution {
	return {
		kind: "convert",
		amountIn,
		outCurrency: to,
		paymentId: "pay_1",
		legId: "leg_x",
		attempt: 1,
		...over,
	}
}

/** The shared code a synchronous call throws, or a description of what happened instead. */
export function codeOf(run: () => unknown): string {
	try {
		run()
	} catch (error) {
		return error instanceof ProviderError
			? error.code
			: `not a ProviderError: ${String(error)}`
	}
	return "no error"
}

export async function codeOfAsync(pending: Promise<unknown>): Promise<string> {
	try {
		await pending
	} catch (error) {
		return error instanceof ProviderError
			? error.code
			: `not a ProviderError: ${String(error)}`
	}
	return "no error"
}
