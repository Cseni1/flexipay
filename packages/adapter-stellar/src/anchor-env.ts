import {
	type StellarAssetIdentity,
	parseClassicAssetLine,
} from "./anchor-asset.ts";

/**
 * Overlay env for the SDF reference anchor and optional anchor vault #2.
 * Does **not** replace baseline `FP_PAYOUT_VAULT_ID` / `FP_USDC_*` in
 * `scripts/testnet/testnet-ids.env`. Load via a separate ids file or process
 * overlay when running M1.
 *
 * CCR-20 accepted names (Claude, 25 Oct 2026): `FP_ANCHOR_*` / `FP_ANCHOR_VAULT_*`.
 */

export const ANCHOR_ENV_NAMES = {
	homeDomain: "FP_ANCHOR_HOME_DOMAIN",
	/** Full `CODE:ISSUER` (never ticker alone). */
	usdcAsset: "FP_ANCHOR_USDC_ASSET",
	usdcContractId: "FP_ANCHOR_USDC_CONTRACT_ID",
	/** Optional second vault id for the anchor asset (M1). */
	anchorVaultId: "FP_ANCHOR_VAULT_ID",
	anchorVaultFeeBps: "FP_ANCHOR_VAULT_FEE_BPS",
	anchorVaultTreasury: "FP_ANCHOR_VAULT_TREASURY_ADDRESS",
	anchorVaultPurpose: "FP_ANCHOR_VAULT_PURPOSE",
	networkPassphrase: "FP_STELLAR_NETWORK_PASSPHRASE",
} as const;

export interface AnchorEventEnv {
	homeDomain: string;
	networkPassphrase: string;
	asset: StellarAssetIdentity;
	/** Present when vault #2 has been deployed. */
	anchorVaultId?: string;
	anchorVaultFeeBps?: number;
	anchorVaultTreasury?: string;
	anchorVaultPurpose?: string;
}

export function loadAnchorEventEnv(
	env: Record<string, string | undefined> = process.env,
): AnchorEventEnv {
	const homeDomain = required(env, ANCHOR_ENV_NAMES.homeDomain);
	const networkPassphrase = required(env, ANCHOR_ENV_NAMES.networkPassphrase);
	const assetLine = required(env, ANCHOR_ENV_NAMES.usdcAsset);
	const contractId = env[ANCHOR_ENV_NAMES.usdcContractId]?.trim();
	const asset = parseClassicAssetLine(
		assetLine,
		networkPassphrase,
		contractId || undefined,
	);
	const out: AnchorEventEnv = { homeDomain, networkPassphrase, asset };
	const vaultId = env[ANCHOR_ENV_NAMES.anchorVaultId]?.trim();
	if (vaultId) out.anchorVaultId = vaultId;
	const feeRaw = env[ANCHOR_ENV_NAMES.anchorVaultFeeBps]?.trim();
	if (feeRaw) {
		const fee = Number(feeRaw);
		if (!Number.isInteger(fee) || fee < 0 || fee > 1000) {
			throw new Error(`${ANCHOR_ENV_NAMES.anchorVaultFeeBps} out of range`);
		}
		out.anchorVaultFeeBps = fee;
	}
	const treasury = env[ANCHOR_ENV_NAMES.anchorVaultTreasury]?.trim();
	if (treasury) out.anchorVaultTreasury = treasury;
	const purpose = env[ANCHOR_ENV_NAMES.anchorVaultPurpose]?.trim();
	if (purpose) out.anchorVaultPurpose = purpose;
	return out;
}

function required(
	env: Record<string, string | undefined>,
	name: string,
): string {
	const v = env[name]?.trim();
	if (!v) throw new Error(`Missing ${name}`);
	return v;
}
