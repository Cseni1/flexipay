import { ProviderError, type SandboxControls } from "@flexipay/domain"

// Sandbox state for one simulated provider (ARCHITECTURE §10, CCR-4 §1). The adapter reads it and
// the controls write it, so a failure never has to travel through the leg data.

export interface ProviderOverride {
	failNext: number
	forcedFailure: boolean
	health: "up" | "down"
}

export function newOverride(): ProviderOverride {
	return { failNext: 0, forcedFailure: false, health: "up" }
}

/**
 * The controls the API calls from /v1/sandbox/*. Every call names a provider; an unknown id or an
 * impossible count is an invalid request and throws the shared `ProviderError`.
 */
export class SimSandboxControls implements SandboxControls {
	private readonly overrides: Map<string, ProviderOverride>

	constructor(overrides: Map<string, ProviderOverride>) {
		this.overrides = overrides
	}

	failNext(providerId: string, count = 1): void {
		if (!Number.isInteger(count) || count < 0) {
			throw new ProviderError(
				"unsupported",
				`failNext needs a whole count, got ${count}`,
			)
		}
		this.state(providerId).failNext = count
	}

	setForcedFailure(providerId: string, on: boolean): void {
		this.state(providerId).forcedFailure = on
	}

	setHealth(providerId: string, health: "up" | "down"): void {
		this.state(providerId).health = health
	}

	reset(): void {
		for (const state of this.overrides.values()) {
			state.failNext = 0
			state.forcedFailure = false
			state.health = "up"
		}
	}

	private state(providerId: string): ProviderOverride {
		const state = this.overrides.get(providerId)
		if (!state) {
			throw new ProviderError(
				"unsupported",
				`no simulated provider ${providerId}`,
			)
		}
		return state
	}
}
