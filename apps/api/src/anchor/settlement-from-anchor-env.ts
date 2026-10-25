import {
	ANCHOR_ENV_NAMES,
	classicAssetLine,
	loadAnchorEventEnv,
	loadStellarEnv,
	type AnchorEventEnv,
	type StellarEnv,
} from "@flexipay/adapter-stellar";
import { createSettlement, type CreateSettlementOptions, type SettlementBundle } from "../settlement.ts";

/**
 * CCR-22: single mapping from FP_ANCHOR_VAULT_* / anchor asset → settlement factory
 * input shape (baseline FP_* names that loadStellarEnv expects).
 * No routing rewrite — callers opt into createAnchorSettlement explicitly.
 * Baseline FP_PAYOUT_VAULT_ID / FP_USDC_* must not equal the anchor overlay.
 */

export class AnchorSettlementConfigError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "AnchorSettlementConfigError";
		this.code = code;
	}
}

export interface AnchorSettlementMapping {
	/** Env map accepted by createSettlement / loadStellarEnv (baseline key names). */
	settlementEnv: Record<string, string | undefined>;
	anchor: AnchorEventEnv;
	/** Parsed via loadStellarEnv for the mapped keys — proves validation. */
	stellar: StellarEnv;
	baselineVaultId: string;
	baselineUsdcAsset: string;
}

/**
 * Map FP_ANCHOR_* → FP_PAYOUT_VAULT_ID / FP_USDC_* / FP_VAULT_FEE_BPS / FP_TREASURY_ADDRESS
 * for the settlement factory only. Asserts no mix with baseline vault/asset.
 */
export function mapAnchorVaultToSettlementEnv(
	env: Record<string, string | undefined> = process.env,
): AnchorSettlementMapping {
	const anchor = loadAnchorEventEnv(env);
	if (!anchor.anchorVaultId) {
		throw new AnchorSettlementConfigError(
			"missing_anchor_vault",
			`Missing ${ANCHOR_ENV_NAMES.anchorVaultId}`,
		);
	}
	if (anchor.anchorVaultFeeBps === undefined) {
		throw new AnchorSettlementConfigError(
			"missing_anchor_vault_fee",
			`Missing ${ANCHOR_ENV_NAMES.anchorVaultFeeBps}`,
		);
	}
	if (!anchor.anchorVaultTreasury) {
		throw new AnchorSettlementConfigError(
			"missing_anchor_treasury",
			`Missing ${ANCHOR_ENV_NAMES.anchorVaultTreasury}`,
		);
	}

	const baselineVaultId = env.FP_PAYOUT_VAULT_ID?.trim() ?? "";
	const baselineUsdcAsset = env.FP_USDC_ASSET?.trim() ?? "";
	const anchorAssetLine = classicAssetLine(anchor.asset);

	if (baselineVaultId && baselineVaultId === anchor.anchorVaultId) {
		throw new AnchorSettlementConfigError(
			"anchor_vault_mixed_with_baseline",
			"FP_ANCHOR_VAULT_ID must not equal baseline FP_PAYOUT_VAULT_ID",
		);
	}
	if (baselineUsdcAsset && baselineUsdcAsset === anchorAssetLine) {
		throw new AnchorSettlementConfigError(
			"anchor_asset_mixed_with_baseline",
			"FP_ANCHOR_USDC_ASSET must not equal baseline FP_USDC_ASSET",
		);
	}

	const network = env.FP_STELLAR_NETWORK?.trim() || "testnet";
	const rpcUrl =
		env.FP_STELLAR_RPC_URL?.trim() || "https://soroban-testnet.stellar.org";
	if (!anchor.asset.contractId) {
		throw new AnchorSettlementConfigError(
			"missing_anchor_usdc_contract",
			`Missing ${ANCHOR_ENV_NAMES.usdcContractId}`,
		);
	}

	const settlementEnv: Record<string, string | undefined> = {
		...env,
		FP_STELLAR_NETWORK: network,
		FP_STELLAR_RPC_URL: rpcUrl,
		FP_STELLAR_NETWORK_PASSPHRASE: anchor.networkPassphrase,
		FP_USDC_ASSET: anchorAssetLine,
		FP_USDC_CONTRACT_ID: anchor.asset.contractId,
		FP_PAYOUT_VAULT_ID: anchor.anchorVaultId,
		FP_VAULT_FEE_BPS: String(anchor.anchorVaultFeeBps),
		FP_TREASURY_ADDRESS: anchor.anchorVaultTreasury,
	};

	// Existing StellarEnv validation (fee range, required keys).
	const stellar = loadStellarEnv(settlementEnv);

	if (stellar.payoutVaultId === baselineVaultId && baselineVaultId) {
		throw new AnchorSettlementConfigError(
			"anchor_vault_mixed_with_baseline",
			"mapped settlement vault equals baseline vault",
		);
	}
	if (stellar.usdcAsset === baselineUsdcAsset && baselineUsdcAsset) {
		throw new AnchorSettlementConfigError(
			"anchor_asset_mixed_with_baseline",
			"mapped settlement asset equals baseline asset",
		);
	}

	return {
		settlementEnv,
		anchor,
		stellar,
		baselineVaultId,
		baselineUsdcAsset,
	};
}

/**
 * Settlement adapter bound to the reference-anchor vault #2 (FP_ANCHOR_VAULT_*).
 * Does not replace runtime.settlement (baseline). No routing rewrite.
 */
export async function createAnchorSettlement(
	options: CreateSettlementOptions = {},
): Promise<SettlementBundle & { mapping: AnchorSettlementMapping }> {
	const env = options.env ?? process.env;
	const mapping = mapAnchorVaultToSettlementEnv(env);
	const bundle = await createSettlement({
		...options,
		env: {
			...mapping.settlementEnv,
			FP_SETTLEMENT: env.FP_SETTLEMENT ?? options.env?.FP_SETTLEMENT ?? "mock",
		},
		/**
		 * Skip baseline testnet-ids.env so FP_PAYOUT_VAULT_ID / FP_USDC_* from the
		 * baseline file cannot overwrite the mapped anchor vault/asset.
		 */
		idsPath: options.idsPath ?? resolveNonexistentAnchorIdsPath(),
	});
	return { ...bundle, mapping };
}

function resolveNonexistentAnchorIdsPath(): string {
	return "C:\\__flexipay_no_baseline_ids_for_anchor_settlement__.env";
}
