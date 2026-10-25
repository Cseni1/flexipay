// CCR-22 amounts. The anchor routes take USDC **major** units as a decimal string in [1, 10]
// for the indicative quote (SEP-38), while the claim view carries Money as integer minor units.
// The withdraw body's `amount` is optional: omitting it makes the backend use the claim's settle
// net, which the browser must not replace with the gross claim amount. This module only converts
// exactly with BigInt: no float, and no rate is computed here.

export const ANCHOR_USDC_DECIMALS = 7
const ANCHOR_MIN_MINOR = 1n * 10n ** 7n
const ANCHOR_MAX_MINOR = 10n * 10n ** 7n

export type AnchorAmountProblem =
	| "currency_not_usdc"
	| "below_minimum"
	| "above_maximum"
	| "invalid_amount"

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

export type AnchorAmountSupport =
	| {
			available: false
			problem: AnchorAmountProblem
	  }
	| {
			available: true
			/**
			 * Claim amount in USDC major units when it is inside the anchor's 1–10 quote window;
			 * null means no indicative quote is requested (the withdraw still uses the API net).
			 */
			quoteAmount: string | null
			/** Why the quote is skipped when `quoteAmount` is null. */
			quoteProblem: AnchorAmountProblem | null
	  }

/**
 * Whether the claim can use the reference-anchor cash-out at all, and what can be quoted.
 *
 * Only USDC claims qualify: the anchor settles USDC and the browser has no FX rate it may use.
 * A claim amount outside 1–10 USDC still gets the cash-out option, because the backend withdraw
 * amount defaults to the claim's **net** (which can be inside the window); the indicative price
 * request itself is limited to 1–10, so it is skipped rather than faked.
 */
export const anchorCashOutSupport = (
	amountMinor: string,
	currency: string,
): AnchorAmountSupport => {
	if (currency !== "USDC") {
		return { available: false, problem: "currency_not_usdc" }
	}
	if (!/^\d+$/.test(amountMinor)) {
		return { available: false, problem: "invalid_amount" }
	}
	const minor = BigInt(amountMinor)
	if (minor < ANCHOR_MIN_MINOR) {
		return {
			available: true,
			quoteAmount: null,
			quoteProblem: "below_minimum",
		}
	}
	if (minor > ANCHOR_MAX_MINOR) {
		return {
			available: true,
			quoteAmount: null,
			quoteProblem: "above_maximum",
		}
	}
	return { available: true, quoteAmount: toMajorString(minor), quoteProblem: null }
}

/** User-facing reason for an amount the contracted anchor cannot quote. */
export const anchorAmountProblemCopy = (
	problem: AnchorAmountProblem,
): string => {
	switch (problem) {
		case "currency_not_usdc":
			return "The reference anchor sells USDC only. This claim is in another currency, and the page will not invent an exchange rate."
		case "below_minimum":
			return "The indicative anchor quote covers at least 1 USDC. This claim is smaller."
		case "above_maximum":
			return "The indicative anchor quote covers at most 10 USDC. This claim is larger; the withdrawal uses the claim's net amount from the API."
		default:
			return "The claim amount is not a valid integer amount."
	}
}
