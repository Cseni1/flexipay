/** Solana settle rails that wait for a verified sender transfer (no vault lock). */
const SOLANA_SETTLE_RAILS = new Set(["solana_usdc", "solana_tgbp"])

export const isSolanaSettleRail = (
	railId: string | null | undefined,
): boolean => railId != null && SOLANA_SETTLE_RAILS.has(railId)
