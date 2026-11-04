import { formatMoney } from "@flexipay/web-lib"
import { type Quote } from "@flexipay/web-lib/contract"
import { formatAssetAmount } from "../solana/assets"

/** Domain minor-unit decimals for quote money codes the send UI formats specially. */
const QUOTE_DECIMALS: Readonly<Record<string, number>> = {
	GBP: 2,
	TGBP: 7,
	USDC: 7,
}

/**
 * Fee/send preview: GBP and TGBP use the CCR-26 £ helper; other codes stay on formatMoney.
 */
export const displayMoney = (amount: string, currency: string): string => {
	if (currency === "GBP") return formatAssetAmount("TGBP", amount, 2)
	if (currency === "TGBP") return formatAssetAmount("TGBP", amount, 7)
	return formatMoney(amount, currency)
}

/**
 * Round (half-up) domain minors to pound pence (2dp). Used so All fees matches
 * the £ amounts shown on the fee lines above (avoids floored API totals in GBP).
 */
export const toPoundPence = (
	amount: string,
	currency: string,
): bigint | null => {
	if (!/^\d+$/.test(amount)) return null
	const minors = BigInt(amount)
	if (currency === "GBP") return minors
	if (currency === "TGBP") {
		// 7 domain decimals → 2dp pounds: divide by 10^5 with half-up.
		const scale = 100_000n
		return (minors + scale / 2n) / scale
	}
	return null
}

/**
 * Display total for the Fees section: sum of the same line items shown above
 * (legs + FlexiPay fee), formatted like those lines when they are GBP/TGBP.
 * Falls back to the API `fees.total` for other currencies.
 */
export const displayFeesTotal = (fees: Quote["fees"]): string => {
	const items = [...fees.legs.map((leg) => leg.fee), fees.flexiPayFee]
	const pences = items.map((item) => toPoundPence(item.amount, item.currency))
	if (pences.length > 0 && pences.every((pence) => pence !== null)) {
		const sum = pences.reduce<bigint>((acc, pence) => acc + (pence ?? 0n), 0n)
		return formatAssetAmount("TGBP", sum.toString(), 2)
	}
	return displayMoney(fees.total.amount, fees.total.currency)
}

/**
 * Rewrite route / exclusion reasons so TGBP (and USDC) amounts use the asset formatter.
 * Example: "… remainder 10000000 TGBP stays unlocked …" → "… remainder £1.00 stays unlocked …"
 */
export const formatQuoteReason = (reason: string): string =>
	reason.replace(
		/\b(\d+)\s+(TGBP|USDC|GBP)\b/g,
		(_match, amount: string, currency: string) => {
			if (currency === "TGBP" || currency === "GBP") {
				const decimals = QUOTE_DECIMALS[currency] ?? 2
				return formatAssetAmount("TGBP", amount, decimals)
			}
			if (currency === "USDC") {
				return formatAssetAmount("USDC", amount, QUOTE_DECIMALS.USDC ?? 7)
			}
			return `${amount} ${currency}`
		},
	)
