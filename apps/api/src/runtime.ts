import type { FlexiPayConfig, ProviderAdapter, SettlementAdapter } from "@flexipay/domain";
import { createSimProviders, type SimProviders } from "@flexipay/adapters-sim";
import { createSettlement, settlementModeFromEnv } from "./settlement.ts";
import { claimSealKeyFromEnv } from "./orchestrator/claim-seal.ts";

/**
 * The API clock (CCR-6). Moves quote and claim expiry only; it never moves ledger time
 * (CCR-5), so the settlement adapters keep their own clock.
 */
export interface ApiClock {
	now(): Date;
	/** Moves the API clock forward by `seconds`; returns the clock after the advance. */
	advance(seconds: number): Date;
	/** Back to wall-clock time (sandbox reset). */
	reset(): void;
}

export function createApiClock(wall: () => Date = () => new Date()): ApiClock {
	let offsetMs = 0;
	return {
		now: () => new Date(wall().getTime() + offsetMs),
		advance(seconds) {
			offsetMs += seconds * 1000;
			return new Date(wall().getTime() + offsetMs);
		},
		reset() {
			offsetMs = 0;
		},
	};
}

export interface ApiRuntime {
	getProvider: (id: string) => ProviderAdapter | undefined;
	settlement: SettlementAdapter;
	/** CCR-10: true when FP_SETTLEMENT=mock. */
	settlementSimulated: boolean;
	vaultPayer: string;
	now: () => Date;
	/** Source of `now`; sandbox advance-time and reset act on it (CCR-6). */
	clock: ApiClock;
	claimSealKey: Buffer;
	/** Base for claim URLs, e.g. https://api.example (no trailing slash). */
	apiPublicBase: string;
	sim?: SimProviders;
}

export async function createApiRuntime(
	config: FlexiPayConfig,
	env: Record<string, string | undefined> = process.env,
): Promise<ApiRuntime> {
	const mode = settlementModeFromEnv(env);
	const { adapter } = await createSettlement({ env });
	const sim = createSimProviders(config);
	const vaultPayer =
		env.FP_PAYER_DEMO_ADDRESS?.trim() ||
		"GDEMOPAYER000000000000000000000000000000000000000000";
	const apiPublicBase = (env.FP_API_URL ?? "").replace(/\/$/, "");
	const clock = createApiClock();
	return {
		getProvider: (id) => sim.providers.get(id),
		settlement: adapter,
		settlementSimulated: mode === "mock",
		vaultPayer,
		now: () => clock.now(),
		clock,
		claimSealKey: claimSealKeyFromEnv(env),
		apiPublicBase,
		sim,
	};
}
