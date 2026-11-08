import { loadSolanaRuntimeConfig } from "@flexipay/adapter-solana";
import { readIndividualLimits } from "./limits.ts";

/**
 * CCR-44: mainnet-beta is refused unless FP_LIVE_MONEY=1, and live mode also
 * needs the individual sender caps. This does not open a network connection.
 */
export function assertLiveMoneyStartup(
	env: Record<string, string | undefined> = process.env,
): void {
	const cfg = loadSolanaRuntimeConfig(env);
	if (cfg.cluster !== "mainnet-beta") return;
	if (!readIndividualLimits(env)) {
		throw new Error(
			"FP_SOLANA_CLUSTER=mainnet-beta with FP_LIVE_MONEY=1 requires FP_INDIVIDUAL_MAX_PAYMENT_USD, FP_INDIVIDUAL_MAX_24H_USD and FP_INDIVIDUAL_MAX_30D_USD",
		);
	}
}
