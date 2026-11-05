import { parseUsdInput } from "@flexipay/web-lib"

/** CCR-27: merchant receive amount in GBP minor units (£1.00 … £10,000.00). */
export const TILL_AMOUNT_MIN_MINOR = 100n
export const TILL_AMOUNT_MAX_MINOR = 1_000_000n

export const TILL_LABEL_MAX = 40

/** Solana base58 address length band used by the till form. */
const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/**
 * Parse a pounds major-unit string into GBP minor units for POST /v1/payment-requests.
 * Returns null when empty, malformed, below £1, or above £10,000.
 */
export function parseTillAmountPounds(input: string): string | null {
	const minors = parseUsdInput(input)
	if (minors === null) return null
	const value = BigInt(minors)
	if (value < TILL_AMOUNT_MIN_MINOR || value > TILL_AMOUNT_MAX_MINOR)
		return null
	return minors
}

export function isValidMerchantWallet(address: string): boolean {
	return WALLET_RE.test(address.trim())
}

/** Optional label: omit when blank; otherwise 1–40 characters. */
export function normalizeTillLabel(label: string): string | null | undefined {
	const trimmed = label.trim()
	if (trimmed === "") return undefined
	if (trimmed.length > TILL_LABEL_MAX) return null
	return trimmed
}
