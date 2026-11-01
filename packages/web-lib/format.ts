/** Minor-unit exponents used for display. The domain package owns conversion arithmetic. */
const DISPLAY_DECIMALS: Readonly<Record<string, number>> = {
	USD: 2,
	PHP: 2,
	BRL: 2,
	ZAR: 2,
	USDC: 7,
}

/**
 * Formats integer minor units as major units without floating-point arithmetic.
 * Unknown currencies fall back to zero decimals; callers should pass a known code.
 */
export function formatMoney(
	amount: string,
	currency: string,
	options: { trimTrailingZeros?: boolean } = {},
): string {
	const decimals = DISPLAY_DECIMALS[currency] ?? 0
	const negative = amount.startsWith("-")
	const digits = (negative ? amount.slice(1) : amount).padStart(
		decimals + 1,
		"0",
	)
	const whole = digits.slice(0, digits.length - decimals)
	const fraction = decimals === 0 ? "" : digits.slice(-decimals)
	const trimmed = options.trimTrailingZeros
		? fraction.replace(/0+$/, "")
		: fraction
	const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
	const value = trimmed ? `${grouped}.${trimmed}` : grouped
	return `${negative ? "-" : ""}${value} ${currency}`
}

/**
 * Parses a major-unit input (e.g. "1,250.00") into integer minor units as a string.
 * USD uses two decimals; no float is ever constructed.
 */
export function parseUsdInput(input: string): string | null {
	const clean = input.trim().replace(/,/g, "")
	const match = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(clean)
	if (!match) return null
	const whole = match[1] ?? "0"
	const fraction = (match[2] ?? "").padEnd(2, "0")
	return `${BigInt(whole) * 100n + BigInt(fraction)}`.replace(/^0+(?=\d)/, "")
}
