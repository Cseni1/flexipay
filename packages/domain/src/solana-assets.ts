// CCR-26: Solana settlement rails and the asset each one settles. Shared by the router and the API
// so "waits for a verified on-chain transfer, no vault lock" is decided in one place.

export const SOLANA_SETTLE_RAIL_BY_ASSET: Readonly<Record<string, string>> = {
  USDC: "solana_usdc",
  TGBP: "solana_tgbp",
};

export const SOLANA_SETTLE_RAILS: readonly string[] = Object.values(SOLANA_SETTLE_RAIL_BY_ASSET);

export const isSolanaSettleRail = (railId: string | null | undefined): boolean =>
  railId != null && SOLANA_SETTLE_RAILS.includes(railId);

/** The Solana rail for a settlement asset code (receive currency), or undefined when unsupported. */
export const solanaRailForAsset = (asset: string): string | undefined =>
  SOLANA_SETTLE_RAIL_BY_ASSET[asset];
