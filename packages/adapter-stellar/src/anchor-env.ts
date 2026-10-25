import {
	type StellarAssetIdentity,
	parseClassicAssetLine,
} from "./anchor-asset.ts";

/**
 * Event overlay env for the SDF reference anchor and optional vault #2.
 * Does **not** replace baseline `FP_PAYOUT_VAULT_ID` / `FP_USDC_*` in
 * `scripts/testnet/testnet-ids.env`. Load via a separate ids file or process
 * overlay when running M1.
 */

export const ANCHOR_ENV_NAMES = {
	homeDomain: "FP_ANCHOR_HOME_DOMAIN",
	/** Full `CODE:ISSUER` (never ticker alone). */
	usdcAsset: "FP_ANCHOR_USDC_ASSET",
	usdcContractId: "FP_ANCHOR_USDC_CONTRACT_ID",
	/** Optional second vault id for the anchor asset (M1). */
	eventPayoutVaultId: "FP_EVENT_PAYOUT_VAULT_ID",
	eventVaultFeeBps: "FP_EVENT_VAULT_FEE_BPS",
	eventTreasury: "FP_EVENT_TREASURY_ADDRESS",
	networkPassphrase: "FP_STELLAR_NETWORK_PASSPHRASE",
} as const;

export interface AnchorEventEnv {
	homeDomain: string;
	networkPassphrase: string;
	asset: StellarAssetIdentity;
	/** Present when vault #2 has been deployed. */
	eventPayoutVaultId?: string;
	eventVaultFeeBps?: number;
	eventTreasury?: string;
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
	const vaultId = env[ANCHOR_ENV_NAMES.eventPayoutVaultId]?.trim();
	if (vaultId) out.eventPayoutVaultId = vaultId;
	const feeRaw = env[ANCHOR_ENV_NAMES.eventVaultFeeBps]?.trim();
	if (feeRaw) {
		const fee = Number(feeRaw);
		if (!Number.isInteger(fee) || fee < 0 || fee > 1000) {
			throw new Error(`${ANCHOR_ENV_NAMES.eventVaultFeeBps} out of range`);
		}
		out.eventVaultFeeBps = fee;
	}
	const treasury = env[ANCHOR_ENV_NAMES.eventTreasury]?.trim();
	if (treasury) out.eventTreasury = treasury;
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
