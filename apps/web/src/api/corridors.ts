import { type EndpointType } from "@flexipay/web-lib/contract"

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
}

export interface DestinationOption {
	value: Extract<EndpointType, "bank_account" | "ewallet" | "crypto_wallet">
	label: string
	currency: string
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

const isSendDestinationType = (
	type: string,
): type is DestinationOption["value"] =>
	(SEND_DESTINATION_TYPES as readonly string[]).includes(type)

/**
 * Map API corridors into destination options for a country.
 * Crypto destinations settle in USDC; fiat uses the corridor's `to` currency.
 */
export const destinationsForCountry = (
	corridors: readonly CorridorSummary[],
	country: string,
): DestinationOption[] => {
	const matching = corridors.filter(
		(corridor) =>
			corridor.fromCountry === "US" && corridor.toCountry === country,
	)
	const byType = new Map<DestinationOption["value"], DestinationOption>()
	for (const corridor of matching) {
		for (const type of corridor.allowedDestinationTypes) {
			if (!isSendDestinationType(type) || byType.has(type)) continue
			byType.set(type, {
				value: type,
				label: DESTINATION_LABELS[type],
				currency: type === "crypto_wallet" ? "USDC" : corridor.toCurrency,
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
	const labels: Record<string, string> = {
		US: "United States",
		PH: "Philippines",
		BR: "Brazil",
		ZA: "South Africa",
	}
	const seen = new Set<string>()
	const countries: { value: string; label: string }[] = []
	for (const corridor of corridors) {
		if (corridor.fromCountry !== "US" || seen.has(corridor.toCountry)) continue
		seen.add(corridor.toCountry)
		countries.push({
			value: corridor.toCountry,
			label: labels[corridor.toCountry] ?? corridor.toCountry,
		})
	}
	return countries
}

export const regulationNoteFor = (
	corridors: readonly CorridorSummary[],
	country: string,
): string | null => {
	const match = corridors.find(
		(corridor) =>
			corridor.fromCountry === "US" && corridor.toCountry === country,
	)
	return match?.regulationNote ?? null
}
