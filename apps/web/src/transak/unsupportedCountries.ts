/**
 * ISO 3166-1 alpha-2 codes where Transak Add funds must stay hidden.
 * GB is included until UK crypto-promotions legal advice is clear.
 */
export const UNSUPPORTED_BUY_COUNTRY_CODES = [
	"AF",
	"AL",
	"DZ",
	"AO",
	"AM",
	"AZ",
	"BD",
	"BB",
	"BY",
	"BO",
	"BA",
	"BG",
	"BF",
	"BI",
	"CM",
	"CF",
	"CN",
	"CD",
	"HR",
	"CU",
	"CI",
	"EG",
	"ER",
	"ET",
	"GI",
	"GT",
	"GN",
	"GW",
	"HT",
	"IR",
	"IQ",
	"JO",
	"KE",
	"KP",
	"XK",
	"LA",
	"LB",
	"LY",
	"MO",
	"ML",
	"MC",
	"MA",
	"MZ",
	"MM",
	"NA",
	"NP",
	"NI",
	"NE",
	"NG",
	"PK",
	"PS",
	"QA",
	"MK",
	"RU",
	"SA",
	"SO",
	"ZA",
	"SS",
	"SD",
	"SY",
	"TZ",
	"TH",
	"TN",
	"TR",
	"UA",
	"VE",
	"VN",
	"VG",
	"YE",
	"ZW",
	"GB",
] as const

export type UnsupportedBuyCountryCode =
	(typeof UNSUPPORTED_BUY_COUNTRY_CODES)[number]

const UNSUPPORTED_SET = new Set<string>(UNSUPPORTED_BUY_COUNTRY_CODES)

/** True when Add funds must stay hidden for this ISO country code. */
export function isUnsupportedBuyCountry(code: string): boolean {
	return UNSUPPORTED_SET.has(code.trim().toUpperCase())
}

/** Extra allowed markets offered in the Buy-from country selector. */
const EXTRA_BUY_COUNTRY_CODES = [
	"AU",
	"BR",
	"CA",
	"DE",
	"ES",
	"FR",
	"IE",
	"IT",
	"JP",
	"MX",
	"NL",
	"PH",
	"PL",
	"PT",
	"SE",
	"SG",
	"US",
] as const

const displayNames =
	typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function"
		? new Intl.DisplayNames(["en"], { type: "region" })
		: null

const countryLabel = (code: string): string => {
	const name = displayNames?.of(code)
	return name && name !== code ? `${name} (${code})` : code
}

/** Options for "Where are you buying from?" (unsupported + common allowed). */
export const ADD_FUNDS_COUNTRY_OPTIONS: ReadonlyArray<{
	value: string
	label: string
}> = Array.from(
	new Set<string>([
		...UNSUPPORTED_BUY_COUNTRY_CODES,
		...EXTRA_BUY_COUNTRY_CODES,
	]),
)
	.map((code) => ({ value: code, label: countryLabel(code) }))
	.sort((a, b) => a.label.localeCompare(b.label))
