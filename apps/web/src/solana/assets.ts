/** CCR-26 Solana settlement assets (web). */
export type SolanaAsset = "USDC" | "TGBP"

export type SolanaAssetConfig = {
	asset: SolanaAsset
	mint: string
	decimals: number
}

/** Display label: pounds first (tGBP), USDC secondary. */
export function assetLabel(asset: SolanaAsset): string {
	return asset === "TGBP" ? "tGBP (£)" : "USDC"
}

/**
 * Format a mint minor-units amount for display.
 * TGBP → GBP-style £ with 2 decimals; USDC → plain major units (up to mint decimals).
 */
export function formatAssetAmount(
	asset: SolanaAsset,
	minor: string | number | bigint,
	decimals: number,
): string {
	const raw =
		typeof minor === "bigint"
			? minor.toString()
			: String(minor).trim().replace(/^\+/, "")
	if (!/^\d+$/.test(raw)) return asset === "TGBP" ? "£—" : "—"
	const scale = Math.max(0, Math.floor(decimals))
	const padded = raw.padStart(scale + 1, "0")
	const whole = padded.slice(0, padded.length - scale) || "0"
	const fraction = scale === 0 ? "" : padded.slice(-scale)
	const major = Number(fraction ? `${whole}.${fraction}` : whole)
	if (!Number.isFinite(major)) return asset === "TGBP" ? "£—" : "—"

	if (asset === "TGBP") {
		return new Intl.NumberFormat("en-GB", {
			style: "currency",
			currency: "GBP",
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		}).format(major)
	}

	return major.toLocaleString(undefined, {
		minimumFractionDigits: 0,
		maximumFractionDigits: Math.min(scale, 6),
	})
}

/** Prefer TGBP when configured; otherwise USDC (legacy configs without assets). */
export function preferredAssetFromConfig(
	assets: SolanaAssetConfig[] | undefined,
	fallback: { mint: string; decimals: number },
): SolanaAssetConfig {
	const list = assets ?? []
	const tgbp = list.find((a) => a.asset === "TGBP")
	if (tgbp) return tgbp
	const usdc = list.find((a) => a.asset === "USDC")
	if (usdc) return usdc
	return {
		asset: "USDC",
		mint: fallback.mint,
		decimals: fallback.decimals,
	}
}
