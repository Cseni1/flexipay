/**
 * Full Stellar asset identity for event work. Never identify an asset by ticker alone:
 * vault USDC (issuer GBBO6N…) and SDF reference-anchor USDC (issuer GBBD47…) are different.
 */

export interface StellarAssetIdentity {
	/** Asset code, e.g. USDC, or "native". */
	code: string;
	/**
	 * Issuer G-address for credit assets. Empty string for native XLM.
	 * Always required for non-native assets.
	 */
	issuer: string;
	/** Exact network passphrase the asset is used on. */
	networkPassphrase: string;
	/** Optional Stellar Asset Contract id (C…) when known. */
	contractId?: string;
}

/** Classic credit-asset form `CODE:ISSUER` (or `native`). */
export function classicAssetLine(asset: StellarAssetIdentity): string {
	assertAssetIdentity(asset);
	if (asset.code === "native" || asset.issuer === "") return "native";
	return `${asset.code}:${asset.issuer}`;
}

/** SEP-38 asset string `stellar:CODE:ISSUER` or `stellar:native`. */
export function sep38AssetString(asset: StellarAssetIdentity): string {
	assertAssetIdentity(asset);
	if (asset.code === "native" || asset.issuer === "") return "stellar:native";
	return `stellar:${asset.code}:${asset.issuer}`;
}

/** Parse `CODE:ISSUER` or `native` into an identity (contract id optional). */
export function parseClassicAssetLine(
	line: string,
	networkPassphrase: string,
	contractId?: string,
): StellarAssetIdentity {
	const trimmed = line.trim();
	if (trimmed === "native" || trimmed === "XLM") {
		return { code: "native", issuer: "", networkPassphrase, contractId };
	}
	const colon = trimmed.indexOf(":");
	if (colon <= 0 || colon === trimmed.length - 1) {
		throw new Error(
			`asset line must be CODE:ISSUER or native; refusing ticker-only value ${JSON.stringify(line)}`,
		);
	}
	const code = trimmed.slice(0, colon);
	const issuer = trimmed.slice(colon + 1);
	if (!/^G[A-Z0-9]{55}$/.test(issuer)) {
		throw new Error(`asset issuer must be a G-address, got ${issuer.slice(0, 8)}…`);
	}
	const asset: StellarAssetIdentity = { code, issuer, networkPassphrase };
	if (contractId) asset.contractId = contractId;
	return asset;
}

export function assertAssetIdentity(asset: StellarAssetIdentity): void {
	if (!asset.networkPassphrase?.trim()) {
		throw new Error("asset.networkPassphrase is required");
	}
	if (!asset.code?.trim()) throw new Error("asset.code is required");
	if (asset.code === "native") {
		if (asset.issuer !== "") {
			throw new Error("native asset must have an empty issuer");
		}
		return;
	}
	if (!asset.issuer || !/^G[A-Z0-9]{55}$/.test(asset.issuer)) {
		throw new Error(
			`credit asset ${asset.code} requires a full issuer G-address (ticker alone is forbidden)`,
		);
	}
}

/** True when code, issuer and network all match (contract id ignored if either side omits it). */
export function sameAsset(
	a: StellarAssetIdentity,
	b: StellarAssetIdentity,
): boolean {
	assertAssetIdentity(a);
	assertAssetIdentity(b);
	if (a.networkPassphrase !== b.networkPassphrase) return false;
	if (a.code === "native" && b.code === "native") return true;
	return a.code === b.code && a.issuer === b.issuer;
}
