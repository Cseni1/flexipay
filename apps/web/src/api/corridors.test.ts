import assert from "node:assert/strict"
import { describe, test } from "vitest"
import {
	countriesFromCorridors,
	destinationsForCountry,
	regulationNoteFor,
	type CorridorSummary,
} from "./corridors.ts"

const SAMPLE: CorridorSummary[] = [
	{
		fromCountry: "US",
		fromCurrency: "USD",
		toCountry: "PH",
		toCurrency: "PHP",
		allowedDestinationTypes: ["bank_account", "ewallet", "crypto_wallet"],
		recipientKinds: ["individual", "company"],
		regulationNote: "PH note",
		simulated: true,
	},
	{
		fromCountry: "US",
		fromCurrency: "USD",
		toCountry: "US",
		toCurrency: "USD",
		allowedDestinationTypes: ["bank_account"],
		recipientKinds: ["individual", "company"],
		regulationNote: "US note",
		simulated: true,
	},
]

describe("corridor destination mapping", () => {
	test("lists unique destination countries from US corridors", () => {
		assert.deepEqual(countriesFromCorridors(SAMPLE), [
			{ value: "PH", label: "Philippines" },
			{ value: "US", label: "United States" },
		])
	})

	test("maps fiat currency from corridor and crypto to USDC", () => {
		assert.deepEqual(destinationsForCountry(SAMPLE, "PH"), [
			{ value: "bank_account", label: "Bank account", currency: "PHP" },
			{ value: "ewallet", label: "E-wallet", currency: "PHP" },
			{ value: "crypto_wallet", label: "Crypto wallet", currency: "USDC" },
		])
	})

	test("returns regulation notes from the matching corridor", () => {
		assert.equal(regulationNoteFor(SAMPLE, "US"), "US note")
		assert.equal(regulationNoteFor(SAMPLE, "ZA"), null)
	})
})
