import { type EndpointType } from "@flexipay/web-lib/contract"
import { providerLabel } from "../payments/providerNames"
import { assetLabel } from "../solana/assets"

/** Browser-safe corridor row used to drive the send form (not the full config schema). */
export interface CorridorSummary {
	fromCountry: string
	fromCurrency: string
	toCountry: string
	toCurrency: string
	allowedDestinationTypes: EndpointType[]
	recipientKinds: string[]
	regulationNote: string
	simulated: boolean
	/** Settlement rail ids from the API corridor (`legsAvailable.settle`), when present. */
	settleRails?: readonly string[]
	/** Payout provider ids from the API corridor (`legsAvailable.payout`), when present. */
	payoutProviders?: readonly string[]
}

export interface DestinationOption {
	value: Extract<EndpointType, "bank_account" | "ewallet" | "crypto_wallet">
	label: string
	currency: string
}

export interface SourceEndpoint {
	type: "bank_account"
	currency: string
	country: string
}

export interface SandboxPayoutRow {
	code: string
	name: string
	providerId: string
	providerName: string
}

const DESTINATION_LABELS: Readonly<Record<DestinationOption["value"], string>> =
	{
		bank_account: "Bank account",
		ewallet: "E-wallet",
		crypto_wallet: "Crypto wallet",
	}

const SEND_DESTINATION_TYPES = [
	"bank_account",
	"ewallet",
	"crypto_wallet",
] as const satisfies readonly DestinationOption["value"][]

const COUNTRY_LABELS: Record<string, string> = {
	US: "United States",
	PH: "Philippines",
	BR: "Brazil",
	ZA: "South Africa",
	GB: "United Kingdom",
}

const regionNames =
	typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function"
		? new Intl.DisplayNames(["en"], { type: "region" })
		: null

/** Display name for a destination country code (Intl name, then the code). */
export const countryLabel = (country: string): string => {
	const known = COUNTRY_LABELS[country]
	if (known) return known
	try {
		return regionNames?.of(country) ?? country
	} catch {
		return country
	}
}

const SETTLE_RAIL_ASSET: Readonly<Record<string, string>> = {
	solana_tgbp: "TGBP",
	solana_usdc: "USDC",
	stellar_usdc: "USDC",
}

const isSendDestinationType = (
	type: string,
): type is DestinationOption["value"] =>
	(SEND_DESTINATION_TYPES as readonly string[]).includes(type)

/**
 * Crypto settle currency from corridor settle rails (CCR-26: TGBP on solana_tgbp).
 * Falls back to TGBP for GBP sources and USDC otherwise so stripped fixtures stay usable.
 */
export const cryptoCurrencyForCorridor = (
	corridor: CorridorSummary,
): string => {
	for (const rail of corridor.settleRails ?? []) {
		const asset = SETTLE_RAIL_ASSET[rail]
		if (asset) return asset
	}
	if (corridor.fromCurrency === "GBP") return "TGBP"
	return "USDC"
}

const cryptoDestinationLabel = (currency: string): string => {
	if (currency === "TGBP") return `Crypto wallet (${assetLabel("TGBP")})`
	return DESTINATION_LABELS.crypto_wallet
}

const matchingCorridors = (
	corridors: readonly CorridorSummary[],
	country: string,
	source?: Pick<SourceEndpoint, "country" | "currency">,
): CorridorSummary[] =>
	corridors.filter((corridor) => {
		if (corridor.toCountry !== country) return false
		if (!source) return true
		return (
			corridor.fromCountry === source.country &&
			corridor.fromCurrency === source.currency
		)
	})

/** Stable key for a bank source endpoint (country + currency). */
export const sourceKey = (
	source: Pick<SourceEndpoint, "country" | "currency">,
): string => `${source.country}:${source.currency}`

/** Parse a source key back into a bank endpoint, or null when malformed. */
export const sourceFromKey = (key: string): SourceEndpoint | null => {
	const [country, currency] = key.split(":")
	if (!country || !currency) return null
	return { type: "bank_account", country, currency }
}

/**
 * Distinct send sources that can pay out to `country`.
 * GBP (UK) is listed before USD (US) when both exist.
 */
export const sourcesForCountry = (
	corridors: readonly CorridorSummary[],
	country: string,
): SourceEndpoint[] => {
	const seen = new Set<string>()
	const sources: SourceEndpoint[] = []
	for (const corridor of matchingCorridors(corridors, country)) {
		const key = sourceKey({
			country: corridor.fromCountry,
			currency: corridor.fromCurrency,
		})
		if (seen.has(key)) continue
		seen.add(key)
		sources.push({
			type: "bank_account",
			currency: corridor.fromCurrency,
			country: corridor.fromCountry,
		})
	}
	return sources.sort((a, b) => {
		const rank = (source: SourceEndpoint) =>
			source.country === "GB" && source.currency === "GBP"
				? 0
				: source.country === "US" && source.currency === "USD"
					? 1
					: 2
		return rank(a) - rank(b) || a.country.localeCompare(b.country)
	})
}

/** Every source across all corridors, pounds first (Send from before a country is picked). */
export const allSources = (
	corridors: readonly CorridorSummary[],
): SourceEndpoint[] => {
	const countries = [...new Set(corridors.map((c) => c.toCountry))]
	const seen = new Set<string>()
	const out: SourceEndpoint[] = []
	for (const country of countries) {
		for (const source of sourcesForCountry(corridors, country)) {
			const key = sourceKey(source)
			if (seen.has(key)) continue
			seen.add(key)
			out.push(source)
		}
	}
	const rank = (s: SourceEndpoint) =>
		s.currency === "GBP" ? 0 : s.currency === "USD" ? 1 : 2
	return out.sort((a, b) => rank(a) - rank(b))
}

/** Prefer a GB/GBP corridor when the destination has more than one source. */
export const defaultSourceForCountry = (
	corridors: readonly CorridorSummary[],
	country: string,
): SourceEndpoint | null => {
	const sources = sourcesForCountry(corridors, country)
	return sources[0] ?? null
}

/** Label for the multi-source "Send from" select. */
export const sendFromLabel = (source: SourceEndpoint): string => {
	if (source.currency === "GBP" && source.country === "GB") {
		return "Pounds: GBP bank account, moves as tGBP (UK)"
	}
	if (source.currency === "USD" && source.country === "US") {
		return "Dollars: USD operating account (US)"
	}
	return `${source.currency} bank account (${source.country})`
}

/** Short label for the static single-source Source field. */
export const sourceStaticLabel = (source: SourceEndpoint): string => {
	if (source.currency === "GBP" && source.country === "GB") {
		return "GBP bank account"
	}
	return "USD operating account"
}

/**
 * Map API corridors into destination options for a country.
 * Fiat uses the corridor `to` currency; crypto uses the settle asset from corridor data.
 * When `source` is set, only that corridor's destinations are used.
 */
export const destinationsForCountry = (
	corridors: readonly CorridorSummary[],
	country: string,
	source?: Pick<SourceEndpoint, "country" | "currency">,
): DestinationOption[] => {
	const matching = matchingCorridors(corridors, country, source)
	const byType = new Map<DestinationOption["value"], DestinationOption>()
	for (const corridor of matching) {
		for (const type of corridor.allowedDestinationTypes) {
			if (!isSendDestinationType(type) || byType.has(type)) continue
			const currency =
				type === "crypto_wallet"
					? cryptoCurrencyForCorridor(corridor)
					: corridor.toCurrency
			byType.set(type, {
				value: type,
				label:
					type === "crypto_wallet"
						? cryptoDestinationLabel(currency)
						: DESTINATION_LABELS[type],
				currency,
			})
		}
	}
	return SEND_DESTINATION_TYPES.flatMap((type) => {
		const option = byType.get(type)
		return option ? [option] : []
	})
}

export const countriesFromCorridors = (
	corridors: readonly CorridorSummary[],
): { value: string; label: string }[] => {
	const seen = new Set<string>()
	const countries: { value: string; label: string }[] = []
	for (const corridor of corridors) {
		if (seen.has(corridor.toCountry)) continue
		seen.add(corridor.toCountry)
		countries.push({
			value: corridor.toCountry,
			label: countryLabel(corridor.toCountry),
		})
	}
	return countries.sort((a, b) => a.label.localeCompare(b.label, "en"))
}

export const regulationNoteFor = (
	corridors: readonly CorridorSummary[],
	country: string,
	source?: Pick<SourceEndpoint, "country" | "currency">,
): string | null => {
	const match = matchingCorridors(corridors, country, source)[0]
	return match?.regulationNote ?? null
}

/**
 * Source bank endpoint for the corridor that pays out to `country`.
 * Prefers GBP/GB when that corridor exists (pounds-first product).
 */
export const sourceForCountry = (
	corridors: readonly CorridorSummary[],
	country: string,
): SourceEndpoint | null => defaultSourceForCountry(corridors, country)

const firstSandboxProvider = (
	providers: readonly string[] | undefined,
): string | null => providers?.find((id) => id.endsWith("_sandbox")) ?? null

/**
 * Destination countries priced by a partner sandbox payout, grouped by send currency.
 * One row per destination country per source currency (first *_sandbox payout id wins).
 */
export const sandboxPayoutsBySource = (
	corridors: readonly CorridorSummary[],
): { GBP: SandboxPayoutRow[]; USD: SandboxPayoutRow[] } => {
	const byCurrency = {
		GBP: new Map<string, SandboxPayoutRow>(),
		USD: new Map<string, SandboxPayoutRow>(),
	}

	for (const corridor of corridors) {
		const providerId = firstSandboxProvider(corridor.payoutProviders)
		if (!providerId) continue
		const group =
			corridor.fromCurrency === "GBP"
				? byCurrency.GBP
				: corridor.fromCurrency === "USD"
					? byCurrency.USD
					: null
		if (!group || group.has(corridor.toCountry)) continue
		group.set(corridor.toCountry, {
			code: corridor.toCountry,
			name: countryLabel(corridor.toCountry),
			providerId,
			providerName: providerLabel(providerId),
		})
	}

	const sortRows = (rows: SandboxPayoutRow[]) =>
		[...rows].sort((a, b) => a.name.localeCompare(b.name, "en"))

	return {
		GBP: sortRows([...byCurrency.GBP.values()]),
		USD: sortRows([...byCurrency.USD.values()]),
	}
}

/** One destination country in the world list: every send currency and every competing partner. */
export type WorldPayoutRow = {
	code: string
	name: string
	/** Send currencies that reach this country, pounds first. */
	from: string[]
	partners: Array<{ id: string; name: string }>
}

/**
 * One world list (CCR-40): each destination country priced by a partner sandbox, with every
 * send currency that reaches it and every partner that competes on it. Sorted by name.
 */
export const sandboxPayoutsWorld = (
	corridors: readonly CorridorSummary[],
): WorldPayoutRow[] => {
	const rows = new Map<string, { from: Set<string>; partners: Set<string> }>()
	for (const corridor of corridors) {
		const partners = (corridor.payoutProviders ?? []).filter((id) =>
			id.endsWith("_sandbox"),
		)
		if (partners.length === 0) continue
		const row = rows.get(corridor.toCountry) ?? {
			from: new Set(),
			partners: new Set(),
		}
		row.from.add(corridor.fromCurrency)
		for (const id of partners) row.partners.add(id)
		rows.set(corridor.toCountry, row)
	}
	const rank = (c: string) => (c === "GBP" ? 0 : c === "USD" ? 1 : 2)
	return [...rows.entries()]
		.map(([code, row]) => ({
			code,
			name: countryLabel(code),
			from: [...row.from].sort(
				(a, b) => rank(a) - rank(b) || a.localeCompare(b),
			),
			partners: [...row.partners]
				.sort()
				.map((id) => ({ id, name: providerLabel(id) })),
		}))
		.sort((a, b) => a.name.localeCompare(b.name, "en"))
}

/** Map a listCorridors row into the browser-safe summary used by Send / Where we pay. */
export const summarizeCorridor = (row: {
	from: { country: string; currency: string }
	to: { country: string; currency: string }
	allowedDestinationTypes: readonly string[]
	recipientKinds: readonly string[]
	regulationNote: string
	simulated: boolean
	settleRails?: readonly string[]
	payoutProviders?: readonly string[]
}): CorridorSummary => ({
	fromCountry: row.from.country,
	fromCurrency: row.from.currency,
	toCountry: row.to.country,
	toCurrency: row.to.currency,
	allowedDestinationTypes: row.allowedDestinationTypes.filter(
		(type): type is EndpointType =>
			type === "bank_account" ||
			type === "ewallet" ||
			type === "crypto_wallet" ||
			type === "crypto_custodial",
	),
	recipientKinds: [...row.recipientKinds],
	regulationNote: row.regulationNote,
	simulated: row.simulated,
	...(row.settleRails ? { settleRails: row.settleRails } : {}),
	...(row.payoutProviders ? { payoutProviders: row.payoutProviders } : {}),
})
