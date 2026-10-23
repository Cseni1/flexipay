import { readFileSync } from "node:fs";
import { CustodialDemoWalletProvider } from "./demo-wallets.ts";
import { StellarSettlementAdapter } from "./settlement.ts";
import { loadStellarEnv, parseEnvFile, type StellarEnv } from "./stellar-env.ts";
import { PayoutVault } from "./vault-client.ts";

// Selection contract for Csaba / the API (ARCHITECTURE §1a, §11.2):
//   FP_SETTLEMENT=mock|stellar  (default mock)
// mock → packages/adapters-sim MockSettlementAdapter (wired in apps/api)
// stellar → createStellarSettlementAdapter() from this package
// This package never constructs the mock; it only exports the stellar path and the mode helper.

export type SettlementMode = "mock" | "stellar";

export function settlementModeFromEnv(
	env: Record<string, string | undefined> = process.env,
): SettlementMode {
	const raw = (env.FP_SETTLEMENT ?? "mock").trim().toLowerCase();
	if (raw === "mock" || raw === "stellar") return raw;
	throw new Error(`FP_SETTLEMENT must be mock|stellar, got ${JSON.stringify(env.FP_SETTLEMENT)}`);
}

export interface CreateStellarSettlementOptions {
	/** Merged public + secret settings. When omitted, process.env is used. */
	env?: Record<string, string | undefined>;
	/** Skip on-chain config() check (tests only). Default true. */
	verifyConfig?: boolean;
	assetCurrency?: string;
}

/**
 * Connects to the deployed payout_vault, loads labelled custodial demo wallets, and returns
 * a SettlementAdapter with network "stellar".
 */
export async function createStellarSettlementAdapter(
	options: CreateStellarSettlementOptions = {},
): Promise<{
	adapter: StellarSettlementAdapter;
	wallets: CustodialDemoWalletProvider;
	env: StellarEnv;
}> {
	const envMap = options.env ?? process.env;
	const stellarEnv = loadStellarEnv(envMap);
	const wallets = CustodialDemoWalletProvider.fromEnv(envMap);
	const vault = await PayoutVault.connect(stellarEnv, {
		verify: options.verifyConfig ?? true,
	});
	const adapter = new StellarSettlementAdapter({
		vault,
		wallets,
		assetCurrency: options.assetCurrency,
	});
	return { adapter, wallets, env: stellarEnv };
}

/**
 * Loads `testnet-ids.env` and optional `.env.secrets` into one map for local/demo use.
 * Does not print values. Prefer host secret injection in deployed environments.
 */
export function loadTestnetEnvFiles(opts: {
	idsPath: string;
	secretsPath?: string;
	/** Extra overlays (e.g. process.env). Later keys win. */
	overlay?: Record<string, string | undefined>;
}): Record<string, string | undefined> {
	const merged: Record<string, string | undefined> = {
		...parseEnvFile(readFileSync(opts.idsPath, "utf8")),
	};
	if (opts.secretsPath) {
		Object.assign(merged, parseEnvFile(readFileSync(opts.secretsPath, "utf8")));
	}
	if (opts.overlay) Object.assign(merged, opts.overlay);
	return merged;
}
