// Plain-English text for "no eligible route" quote refusals. The API returns routing reasons as
// engineering strings (e.g. "sim_bank_ph_instapay takes at most 5000000 PHP"); the page shows
// these helpers' sentences first and keeps the raw reasons in a technical-details disclosure.
// Pure functions, no browser or kit imports, so they stay unit-testable.

/** Minor-unit exponents, mirroring the display table in format.ts. */
const DECIMALS: Readonly<Record<string, number>> = {
	USD: 2,
	PHP: 2,
	BRL: 2,
	ZAR: 2,
	USDC: 7,
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
	sim_bank_ph_instapay: "The Philippines bank transfer (InstaPay)",
	sim_ewallet_ph: "The Philippines e-wallet",
}

/** Internal accounting notes that ride along in `reasons` but mean nothing to a sender. */
const INTERNAL_NOTE = /CCR-\d|settle remainder|stays unlocked/i

function money(minor: string, currency: string): string {
	const decimals = DECIMALS[currency] ?? 0
	const digits = minor.padStart(decimals + 1, "0")
	const whole = digits.slice(0, digits.length - decimals)
	const fraction = decimals === 0 ? "" : digits.slice(-decimals)
	const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
	return fraction ? `${currency} ${grouped}.${fraction}` : `${currency} ${grouped}`
}

function providerLabel(id: string): string {
	const known = PROVIDER_LABELS[id]
	if (known) return known
	if (/ewallet/i.test(id)) return "This e-wallet option"
	if (/bank/i.test(id)) return "This bank transfer option"
	return "This payout option"
}

function sentenceFor(reason: string): string | null {
	const most = /^(\S+) takes at most (\d+) ([A-Z]{3,5})$/.exec(reason.trim())
	if (most) {
		const [, id, amount, currency] = most
		return `${providerLabel(id!)} accepts payments up to ${money(amount!, currency!)}. Your amount is higher. Try a smaller amount or choose another payout method.`
	}
	const least = /^(\S+) takes at least (\d+) ([A-Z]{3,5})$/.exec(reason.trim())
	if (least) {
		const [, id, amount, currency] = least
		return `${providerLabel(id!)} needs at least ${money(amount!, currency!)} per payment. Your amount is lower. Try a larger amount.`
	}
	const down = /^Provider (\S+) is down$/.exec(reason.trim())
	if (down) {
		return `${providerLabel(down[1]!)} is temporarily unavailable. Try again shortly or choose another payout method.`
	}
	if (/^no configured rate /.test(reason.trim())) {
		return "There is no exchange rate for this currency pair yet. Try a different destination."
	}
	return null
}

export interface FriendlyQuoteError {
	/** Sentence(s) for the sender; empty only when the API gave no usable reason. */
	message: string
	/** Original reasons exactly as the API sent them, for the operator disclosure. */
	technical: string[]
}

/**
 * Turns routing refusal reasons into plain English. Known limit/availability reasons become
 * sentences; other reasons that are already readable (e.g. a country exclusion) pass through;
 * internal accounting notes are dropped.
 */
export function friendlyQuoteError(reasons: readonly string[]): FriendlyQuoteError {
	const technical = [...reasons]
	const sentences: string[] = []
	for (const reason of reasons) {
		if (INTERNAL_NOTE.test(reason)) continue
		const friendly = sentenceFor(reason)
		const text = friendly ?? reason.trim()
		if (text && !sentences.includes(text)) sentences.push(text)
	}
	return {
		message:
			sentences.length > 0
				? sentences.join(" ")
				: "This payment can't be routed with these details. Try a different amount or payout method.",
		technical,
	}
}
