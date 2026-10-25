// CCR-22 amounts. The anchor routes take USDC **major** units as a decimal string in [1, 10]
// (SEP-38/Sep-24 convention), while the claim view carries Money as integer minor units. This
// converts exactly with BigInt: no float, and no rate is ever computed here.
//
// The claim amount is the only cash-out amount the page has, so it is what gets quoted and
// withdrawn. A partial cash-out needs a contracted amount field; this module does not invent one.

export const ANCHOR_USDC_DECIMALS = 7
const ANCHOR_MIN_MINOR = 1n * 10n ** 7n
const ANCHOR_MAX_MINOR = 10n * 10n ** 7n

export type AnchorAmountProblem =
	| "currency_not_usdc"
	| "below_minimum"
	| "above_maximum"
	| "invalid_amount"

export type AnchorAmountResult =
	| { ok: true; sellAmount: string }
	| { ok: false; problem: AnchorAmountProblem }

/** Exact minor → major conversion, trailing zeros trimmed (e.g. 50000000 → "5"). */
const toMajorString = (minor: bigint): string => {
	const scale = 10n ** BigInt(ANCHOR_USDC_DECIMALS)
	const whole = minor / scale
	const fraction = (minor % scale)
		.toString()
		.padStart(ANCHOR_USDC_DECIMALS, "0")
		.replace(/0+$/, "")
	return fraction ? `${whole}.${fraction}` : `${whole}`
}

/**
 * Maps the claim's Money to the contracted anchor sell amount. Only USDC can be quoted because
 * the anchor sells its own USDC; converting another currency would need an FX rate the browser
 * does not have and must not invent.
 */
export const anchorSellAmount = (
	amountMinor: string,
	currency: string,
): AnchorAmountResult => {
	if (currency !== "USDC") return { ok: false, problem: "currency_not_usdc" }
	if (!/^\d+$/.test(amountMinor)) return { ok: false, problem: "invalid_amount" }
	const minor = BigInt(amountMinor)
	if (minor < ANCHOR_MIN_MINOR) return { ok: false, problem: "below_minimum" }
	if (minor > ANCHOR_MAX_MINOR) return { ok: false, problem: "above_maximum" }
	return { ok: true, sellAmount: toMajorString(minor) }
}

/** User-facing reason for an amount the contracted anchor cannot quote. */
export const anchorAmountProblemCopy = (
	problem: AnchorAmountProblem,
): string => {
	switch (problem) {
		case "currency_not_usdc":
			return "The reference anchor sells USDC only. This claim is in another currency, and the page will not invent an exchange rate."
		case "below_minimum":
			return "The reference anchor's testnet withdrawal limit is 1 USDC minimum. This claim is smaller."
		case "above_maximum":
			return "The reference anchor's testnet withdrawal limit is 10 USDC maximum. This claim is larger."
		default:
			return "The claim amount is not a valid integer amount."
	}
}
