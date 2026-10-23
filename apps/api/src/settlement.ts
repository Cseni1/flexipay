import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { SettlementAdapter } from "@flexipay/domain";
import { MockSettlementAdapter } from "@flexipay/adapters-sim";
import {
	createStellarSettlementAdapter,
	loadTestnetEnvFiles,
	settlementModeFromEnv,
	type SettlementMode,
} from "@flexipay/adapter-stellar";

// FP_SETTLEMENT selection (ARCHITECTURE §1a / §11.2). The orchestrator (CC2/CC3) will consume
// this adapter; A0/SC2 integration only wires the factory so mock vs stellar is one setting.

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DEFAULT_IDS = resolve(REPO_ROOT, "scripts/testnet/testnet-ids.env");
const DEFAULT_SECRETS = resolve(REPO_ROOT, "scripts/testnet/.env.secrets");

export interface SettlementBundle {
	mode: SettlementMode;
	adapter: SettlementAdapter;
}

export interface CreateSettlementOptions {
	env?: Record<string, string | undefined>;
	/** Mock vault clock; defaults to wall clock. */
	now?: () => Date;
	idsPath?: string;
	secretsPath?: string;
}

/**
 * Builds the settlement adapter selected by `FP_SETTLEMENT` (default `mock`).
 * Stellar mode loads public ids + optional secrets; it never prints secrets.
 */
export async function createSettlement(
	options: CreateSettlementOptions = {},
): Promise<SettlementBundle> {
	const env = options.env ?? process.env;
	const mode = settlementModeFromEnv(env);
	if (mode === "mock") {
		const idsPath = options.idsPath ?? DEFAULT_IDS;
		const publicEnv = existsSync(idsPath)
			? loadTestnetEnvFiles({ idsPath, overlay: env })
			: env;
		const treasury =
			publicEnv.FP_TREASURY_ADDRESS ??
			"GDEMOTREASURY0000000000000000000000000000000000000000";
		const feeBps = Number(publicEnv.FP_VAULT_FEE_BPS ?? 100);
		const adapter = new MockSettlementAdapter({
			token: "USDC",
			treasury,
			feeBps: Number.isInteger(feeBps) ? feeBps : 100,
			now: options.now ?? (() => new Date()),
		});
		return { mode, adapter };
	}

	const idsPath = options.idsPath ?? DEFAULT_IDS;
	const secretsPath = options.secretsPath ?? DEFAULT_SECRETS;
	const merged = loadTestnetEnvFiles({
		idsPath,
		...(existsSync(secretsPath) ? { secretsPath } : {}),
		overlay: env,
	});
	const { adapter } = await createStellarSettlementAdapter({ env: merged });
	return { mode, adapter };
}

export { settlementModeFromEnv };
