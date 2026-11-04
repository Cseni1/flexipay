import { type EndpointType } from "@flexipay/web-lib/contract"
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

/** Display name for a destination country code (falls back to the code). */
export const countryLabel = (country: string): string =>
	COUNTRY_LABELS[country] ?? country

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
): CorridorSummary[] =>
	corridors.filter((corridor) => corridor.toCountry === country)

/**
 * Map API corridors into destination options for a country.
 * Fiat uses the corridor `to` currency; crypto uses the settle asset from corridor data.
 */
export const destinationsForCountry = (
	corridors: readonly CorridorSummary[],
	country: string,
): DestinationOption[] => {
	const matching = matchingCorridors(corridors, country)
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
	return countries
}

export const regulationNoteFor = (
	corridors: readonly CorridorSummary[],
	country: string,
): string | null => {
	const match = matchingCorridors(corridors, country)[0]
	return match?.regulationNote ?? null
}

/** Source bank endpoint for the corridor that pays out to `country`. */
export const sourceForCountry = (
	corridors: readonly CorridorSummary[],
	country: string,
): SourceEndpoint | null => {
	const match = matchingCorridors(corridors, country)[0]
	if (!match) return null
	return {
		type: "bank_account",
		currency: match.fromCurrency,
		country: match.fromCountry,
	}
}
