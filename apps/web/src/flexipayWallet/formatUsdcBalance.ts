/**
 * Format Crossmint `wallet.balances().usdc.amount` for display.
 * Prefers the human `amount` string; falls back to raw + decimals when needed.
 */
export function formatUsdcBalance(
	usdc: {
		amount?: string
		rawAmount?: string
		decimals?: number
	} | null,
): string {
	if (!usdc) return "—"
	const amount = usdc.amount?.trim()
	if (amount && amount.length > 0) {
		const asNumber = Number(amount)
		if (Number.isFinite(asNumber)) {
			return asNumber.toLocaleString(undefined, {
				minimumFractionDigits: 2,
				maximumFractionDigits: 6,
			})
		}
		return amount
	}
	const raw = usdc.rawAmount?.trim()
	const decimals = usdc.decimals ?? 6
	if (!raw || !/^\d+$/.test(raw)) return "—"
	const padded = raw.padStart(decimals + 1, "0")
	const whole = padded.slice(0, -decimals) || "0"
	const fraction = padded.slice(-decimals).replace(/0+$/, "")
	const value = fraction ? `${whole}.${fraction}` : whole
	const asNumber = Number(value)
	if (!Number.isFinite(asNumber)) return value
	return asNumber.toLocaleString(undefined, {
		minimumFractionDigits: 2,
		maximumFractionDigits: 6,
	})
}
