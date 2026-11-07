import assert from "node:assert/strict"
import { describe, test } from "vitest"
import {
	countriesFromCorridors,
	countryLabel,
	cryptoCurrencyForCorridor,
	defaultSourceForCountry,
	destinationsForCountry,
	regulationNoteFor,
	sandboxPayoutsBySource,
	sandboxPayoutsWorld,
	sendFromLabel,
	sourceForCountry,
	sourcesForCountry,
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
		regulationNote: "PH USD note",
		simulated: true,
		settleRails: ["stellar_usdc"],
		payoutProviders: ["sim_ewallet_ph", "tazapay_sandbox"],
	},
	{
		fromCountry: "GB",
		fromCurrency: "GBP",
		toCountry: "PH",
		toCurrency: "PHP",
		allowedDestinationTypes: ["bank_account", "ewallet", "crypto_wallet"],
		recipientKinds: ["individual", "company"],
		regulationNote: "PH GBP note",
		simulated: true,
		settleRails: ["solana_tgbp"],
		payoutProviders: ["tazapay_sandbox"],
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
	{
		fromCountry: "GB",
		fromCurrency: "GBP",
		toCountry: "KE",
		toCurrency: "KES",
		allowedDestinationTypes: ["bank_account"],
		recipientKinds: ["individual", "company"],
		regulationNote: "KE GBP note",
		simulated: true,
		payoutProviders: ["tazapay_sandbox"],
	},
]

describe("corridor destination mapping", () => {
	test("lists unique destination countries including GB, sorted by name", () => {
		assert.deepEqual(countriesFromCorridors(SAMPLE), [
			{ value: "KE", label: "Kenya" },
			{ value: "PH", label: "Philippines" },
			{ value: "GB", label: "United Kingdom" },
			{ value: "US", label: "United States" },
		])
	})

	test("names countries without a fixed label (CCR-31 Tazapay coverage)", () => {
		assert.equal(countryLabel("KE"), "Kenya")
		assert.equal(countryLabel("VN"), "Vietnam")
	})

	test("maps fiat currency from corridor and crypto from settle rails", () => {
		assert.deepEqual(
			destinationsForCountry(SAMPLE, "PH", {
				country: "US",
				currency: "USD",
			}),
			[
				{ value: "bank_account", label: "Bank account", currency: "PHP" },
				{ value: "ewallet", label: "E-wallet", currency: "PHP" },
				{ value: "crypto_wallet", label: "Crypto wallet", currency: "USDC" },
			],
		)
		assert.deepEqual(
			destinationsForCountry(SAMPLE, "PH", {
				country: "GB",
				currency: "GBP",
			}),
			[
				{ value: "bank_account", label: "Bank account", currency: "PHP" },
				{ value: "ewallet", label: "E-wallet", currency: "PHP" },
				{
					value: "crypto_wallet",
					label: "Crypto wallet (tGBP (£))",
					currency: "TGBP",
				},
			],
		)
		assert.deepEqual(destinationsForCountry(SAMPLE, "GB"), [
			{
				value: "crypto_wallet",
				label: "Crypto wallet (tGBP (£))",
				currency: "TGBP",
			},
		])
	})

	test("returns regulation notes and prefers GBP source when available", () => {
		assert.equal(regulationNoteFor(SAMPLE, "US"), "US note")
		assert.equal(regulationNoteFor(SAMPLE, "ZA"), null)
		assert.equal(regulationNoteFor(SAMPLE, "GB"), "UK GBP to tGBP")
		assert.equal(
			regulationNoteFor(SAMPLE, "PH", { country: "GB", currency: "GBP" }),
			"PH GBP note",
		)
		assert.deepEqual(sourceForCountry(SAMPLE, "GB"), {
			type: "bank_account",
			currency: "GBP",
			country: "GB",
		})
		assert.deepEqual(sourceForCountry(SAMPLE, "PH"), {
			type: "bank_account",
			currency: "GBP",
			country: "GB",
		})
		assert.deepEqual(sourcesForCountry(SAMPLE, "PH"), [
			{ type: "bank_account", currency: "GBP", country: "GB" },
			{ type: "bank_account", currency: "USD", country: "US" },
		])
		assert.deepEqual(sourcesForCountry(SAMPLE, "KE"), [
			{ type: "bank_account", currency: "GBP", country: "GB" },
		])
		assert.deepEqual(defaultSourceForCountry(SAMPLE, "PH"), {
			type: "bank_account",
			currency: "GBP",
			country: "GB",
		})
		assert.equal(
			sendFromLabel({ type: "bank_account", currency: "GBP", country: "GB" }),
			"Pounds: GBP bank account, moves as tGBP (UK)",
		)
		assert.equal(
			sendFromLabel({ type: "bank_account", currency: "USD", country: "US" }),
			"Dollars: USD operating account (US)",
		)
	})

	test("groups sandbox payout countries by send currency", () => {
		assert.deepEqual(sandboxPayoutsBySource(SAMPLE), {
			GBP: [
				{
					code: "KE",
					name: "Kenya",
					providerId: "tazapay_sandbox",
					providerName: "Tazapay",
				},
				{
					code: "PH",
					name: "Philippines",
					providerId: "tazapay_sandbox",
					providerName: "Tazapay",
				},
			],
			USD: [
				{
					code: "PH",
					name: "Philippines",
					providerId: "tazapay_sandbox",
					providerName: "Tazapay",
				},
			],
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

	test("world list: one row per country with every send currency and partner (CCR-40)", () => {
		const corridors = [
			{
				...SAMPLE[0]!,
				toCountry: "MX",
				fromCurrency: "USD",
				fromCountry: "US",
				payoutProviders: ["blindpay_sandbox", "tazapay_sandbox"],
			},
			{
				...SAMPLE[0]!,
				toCountry: "MX",
				fromCurrency: "GBP",
				fromCountry: "GB",
				payoutProviders: ["tazapay_sandbox"],
			},
			{
				...SAMPLE[0]!,
				toCountry: "KE",
				fromCurrency: "GBP",
				fromCountry: "GB",
				payoutProviders: ["tazapay_sandbox"],
			},
			{
				...SAMPLE[0]!,
				toCountry: "ZA",
				fromCurrency: "USD",
				fromCountry: "US",
				payoutProviders: ["sim_bank_za_eft"],
			},
		] as CorridorSummary[]
		const rows = sandboxPayoutsWorld(corridors)
		assert.deepEqual(
			rows.map((r) => r.code),
			["KE", "MX"],
		)
		assert.deepEqual(rows[1]!.from, ["GBP", "USD"])
		assert.deepEqual(
			rows[1]!.partners.map((p) => p.id),
			["blindpay_sandbox", "tazapay_sandbox"],
		)
	})
})
