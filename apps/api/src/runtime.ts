import type { FlexiPayConfig, ProviderAdapter, SettlementAdapter } from "@flexipay/domain";
import { createSimProviders, type SimProviders } from "@flexipay/adapters-sim";
import { createSettlement, settlementModeFromEnv } from "./settlement.ts";
import { claimSealKeyFromEnv } from "./orchestrator/claim-seal.ts";

export interface ApiRuntime {
	getProvider: (id: string) => ProviderAdapter | undefined;
	settlement: SettlementAdapter;
	/** CCR-10: true when FP_SETTLEMENT=mock. */
	settlementSimulated: boolean;
	vaultPayer: string;
	now: () => Date;
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
	return {
		getProvider: (id) => sim.providers.get(id),
		settlement: adapter,
		settlementSimulated: mode === "mock",
		vaultPayer,
		now: () => new Date(),
		claimSealKey: claimSealKeyFromEnv(env),
		apiPublicBase,
		sim,
	};
}
