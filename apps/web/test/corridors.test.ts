import assert from "node:assert/strict"
import { describe, test } from "vitest"
import {
	countriesFromCorridors,
	cryptoCurrencyForCorridor,
	destinationsForCountry,
	regulationNoteFor,
	sourceForCountry,
	type CorridorSummary,
} from "../src/api/corridors.ts"

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
		settleRails: ["stellar_usdc"],
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
	{
		fromCountry: "GB",
		fromCurrency: "GBP",
		toCountry: "GB",
		toCurrency: "GBP",
		allowedDestinationTypes: ["crypto_wallet"],
		recipientKinds: ["individual", "company"],
		regulationNote: "UK GBP to tGBP",
		simulated: true,
		settleRails: ["solana_tgbp"],
	},
]

describe("corridor destination mapping", () => {
	test("lists unique destination countries including GB", () => {
		assert.deepEqual(countriesFromCorridors(SAMPLE), [
			{ value: "PH", label: "Philippines" },
			{ value: "US", label: "United States" },
			{ value: "GB", label: "United Kingdom" },
		])
	})

	test("maps fiat currency from corridor and crypto from settle rails", () => {
		assert.deepEqual(destinationsForCountry(SAMPLE, "PH"), [
			{ value: "bank_account", label: "Bank account", currency: "PHP" },
			{ value: "ewallet", label: "E-wallet", currency: "PHP" },
			{ value: "crypto_wallet", label: "Crypto wallet", currency: "USDC" },
		])
		assert.deepEqual(destinationsForCountry(SAMPLE, "GB"), [
			{
				value: "crypto_wallet",
				label: "Crypto wallet (tGBP (£))",
				currency: "TGBP",
			},
		])
	})

	test("returns regulation notes and source from the matching corridor", () => {
		assert.equal(regulationNoteFor(SAMPLE, "US"), "US note")
		assert.equal(regulationNoteFor(SAMPLE, "ZA"), null)
		assert.equal(regulationNoteFor(SAMPLE, "GB"), "UK GBP to tGBP")
		assert.deepEqual(sourceForCountry(SAMPLE, "GB"), {
			type: "bank_account",
			currency: "GBP",
			country: "GB",
		})
		assert.deepEqual(sourceForCountry(SAMPLE, "PH"), {
			type: "bank_account",
			currency: "USD",
			country: "US",
		})
	})

	test("crypto settle currency falls back when settle rails are absent", () => {
		assert.equal(
			cryptoCurrencyForCorridor({
				fromCountry: "GB",
				fromCurrency: "GBP",
				toCountry: "GB",
				toCurrency: "GBP",
				allowedDestinationTypes: ["crypto_wallet"],
				recipientKinds: ["individual"],
				regulationNote: "note",
				simulated: true,
			}),
			"TGBP",
		)
		assert.equal(
			cryptoCurrencyForCorridor({
				fromCountry: "US",
				fromCurrency: "USD",
				toCountry: "BR",
				toCurrency: "BRL",
				allowedDestinationTypes: ["crypto_wallet"],
				recipientKinds: ["individual"],
				regulationNote: "note",
				simulated: true,
			}),
			"USDC",
		)
	})
})
