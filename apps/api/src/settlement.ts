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
	/**
	 * When true, do not load baseline `testnet-ids.env` — use `env` (and optional
	 * secrets) only. Used by CCR-22 anchor vault mapping so baseline FP_USDC_* /
	 * FP_PAYOUT_VAULT_ID cannot overwrite the mapped overlay.
	 */
	skipBaselineIds?: boolean;
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
		const publicEnv = options.skipBaselineIds
			? env
			: (() => {
					const idsPath = options.idsPath ?? DEFAULT_IDS;
					return existsSync(idsPath)
						? loadTestnetEnvFiles({ idsPath, overlay: env })
						: env;
				})();
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

	const secretsPath = options.secretsPath ?? DEFAULT_SECRETS;
	let stellarEnv: Record<string, string | undefined>;
	if (options.skipBaselineIds) {
		// Anchor overlay only: optional secrets file, then caller `env` wins.
		stellarEnv = { ...env };
		if (existsSync(secretsPath)) {
			stellarEnv = loadTestnetEnvFiles({
				idsPath: secretsPath,
				overlay: env,
			});
		}
	} else {
		stellarEnv = loadTestnetEnvFiles({
			idsPath: options.idsPath ?? DEFAULT_IDS,
			...(existsSync(secretsPath) ? { secretsPath } : {}),
			overlay: env,
		});
	}
	const { adapter } = await createStellarSettlementAdapter({ env: stellarEnv });
	return { mode, adapter };
}

export { settlementModeFromEnv };
