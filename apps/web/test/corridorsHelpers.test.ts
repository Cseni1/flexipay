import assert from "node:assert/strict"
import { describe, test } from "vitest"
import {
	allSources,
	countryLabel,
	cryptoCurrencyForCorridor,
	destinationsForCountry,
	regulationNoteFor,
	sandboxPayoutsBySource,
	sandboxPayoutsWorld,
	sendFromLabel,
	sourceFromKey,
	sourceKey,
	sourcesForCountry,
	sourceStaticLabel,
	summarizeCorridor,
	type CorridorSummary,
} from "../src/api/corridors.ts"

const corridor = (
	from: [string, string],
	to: [string, string],
	extra: Partial<CorridorSummary> = {},
): CorridorSummary => ({
	fromCountry: from[0],
	fromCurrency: from[1],
	toCountry: to[0],
	toCurrency: to[1],
	allowedDestinationTypes: ["bank_account"],
	recipientKinds: ["individual"],
	regulationNote: `${from[1]}→${to[0]}`,
	simulated: true,
	...extra,
})

describe("source keys and labels", () => {
	test("sourceKey round-trips through sourceFromKey; malformed keys are null", () => {
		const key = sourceKey({ country: "GB", currency: "GBP" })
		assert.equal(key, "GB:GBP")
		assert.deepEqual(sourceFromKey(key), {
			type: "bank_account",
			country: "GB",
			currency: "GBP",
		})
		assert.equal(sourceFromKey("GB"), null)
		assert.equal(sourceFromKey(":GBP"), null)
		assert.equal(sourceFromKey(""), null)
	})

	test("send-from and static labels", () => {
		const eur = {
			type: "bank_account" as const,
			country: "DE",
			currency: "EUR",
		}
		assert.equal(sendFromLabel(eur), "EUR bank account (DE)")
		assert.match(
			sendFromLabel({ type: "bank_account", country: "US", currency: "USD" }),
			/^Dollars/,
		)
		assert.equal(
			sourceStaticLabel({
				type: "bank_account",
				country: "GB",
				currency: "GBP",
			}),
			"GBP bank account",
		)
		assert.equal(
			sourceStaticLabel({
				type: "bank_account",
				country: "US",
				currency: "USD",
			}),
			"USD operating account",
		)
	})

	// BUG: sourceStaticLabel returns "USD operating account" for every source that is not
	// GB/GBP, so a single-source corridor sending from e.g. EUR (DE) would be labelled as a
	// USD account. Expected: a generic "<CUR> bank account" like sendFromLabel uses.
	test.fails(
		"static label for a non-GBP, non-USD source names its own currency",
		() => {
			assert.equal(
				sourceStaticLabel({
					type: "bank_account",
					country: "DE",
					currency: "EUR",
				}),
				"EUR bank account",
			)
		},
	)

	test("countryLabel: fixed names, Intl names, and unknown codes", () => {
		assert.equal(countryLabel("GB"), "United Kingdom")
		assert.equal(countryLabel("KE"), "Kenya")
		// Invalid region codes make Intl throw; the code is returned as-is.
		assert.equal(countryLabel("not-a-code"), "not-a-code")
	})
})

describe("sources across corridors", () => {
	const corridors = [
		corridor(["US", "USD"], ["PH", "PHP"]),
		corridor(["DE", "EUR"], ["PH", "PHP"]),
		corridor(["AT", "EUR"], ["PH", "PHP"]),
		corridor(["GB", "GBP"], ["PH", "PHP"]),
		corridor(["GB", "GBP"], ["PH", "PHP"]),
		corridor(["US", "USD"], ["KE", "KES"]),
		corridor(["JP", "JPY"], ["KE", "KES"]),
	]

	test("sourcesForCountry dedupes and ranks GBP, USD, then others by country", () => {
		assert.deepEqual(sourcesForCountry(corridors, "PH").map(sourceKey), [
			"GB:GBP",
			"US:USD",
			"AT:EUR",
			"DE:EUR",
		])
		assert.deepEqual(sourcesForCountry(corridors, "ZZ"), [])
	})

	test("allSources lists every distinct source, pounds then dollars first", () => {
		const keys = allSources(corridors).map(sourceKey)
		assert.deepEqual(keys.slice(0, 2), ["GB:GBP", "US:USD"])
		assert.deepEqual(
			new Set(keys),
			new Set(["GB:GBP", "US:USD", "AT:EUR", "DE:EUR", "JP:JPY"]),
		)
		assert.equal(keys.length, 5)
		assert.deepEqual(allSources([]), [])
	})

	test("regulationNoteFor respects the chosen source and handles no match", () => {
		assert.equal(
			regulationNoteFor(corridors, "PH", { country: "DE", currency: "EUR" }),
			"EUR→PH",
		)
		assert.equal(
			regulationNoteFor(corridors, "PH", { country: "FR", currency: "EUR" }),
			null,
		)
		assert.equal(regulationNoteFor(corridors, "ZZ"), null)
	})
})

describe("destinations", () => {
	test("orders bank, e-wallet, crypto; skips custodial and unknown types; first corridor wins", () => {
		const corridors = [
			corridor(["GB", "GBP"], ["PH", "PHP"], {
				allowedDestinationTypes: [
					"crypto_custodial",
					"crypto_wallet",
					"ewallet",
				],
				settleRails: ["unknown_rail", "solana_tgbp"],
			}),
			corridor(["US", "USD"], ["PH", "USD"], {
				allowedDestinationTypes: ["ewallet", "bank_account", "crypto_wallet"],
				settleRails: ["stellar_usdc"],
			}),
		]
		assert.deepEqual(destinationsForCountry(corridors, "PH"), [
			{ value: "bank_account", label: "Bank account", currency: "USD" },
			{ value: "ewallet", label: "E-wallet", currency: "PHP" },
			{
				value: "crypto_wallet",
				label: "Crypto wallet (tGBP (£))",
				currency: "TGBP",
			},
		])
		assert.deepEqual(
			destinationsForCountry(corridors, "PH", {
				country: "US",
				currency: "USD",
			}).map((d) => [d.value, d.label, d.currency]),
			[
				["bank_account", "Bank account", "USD"],
				["ewallet", "E-wallet", "USD"],
				["crypto_wallet", "Crypto wallet", "USDC"],
			],
		)
		assert.deepEqual(destinationsForCountry(corridors, "BR"), [])
	})

	test("crypto currency from rails, else by source currency", () => {
		assert.equal(
			cryptoCurrencyForCorridor(
				corridor(["US", "USD"], ["PH", "PHP"], {
					settleRails: ["solana_usdc"],
				}),
			),
			"USDC",
		)
		assert.equal(
			cryptoCurrencyForCorridor(corridor(["EU", "EUR"], ["PH", "PHP"])),
			"USDC",
		)
		assert.equal(
			cryptoCurrencyForCorridor(
				corridor(["GB", "GBP"], ["PH", "PHP"], { settleRails: [] }),
			),
			"TGBP",
		)
	})
})

describe("sandbox payout lists", () => {
	const corridors = [
		corridor(["GB", "GBP"], ["PH", "PHP"], {
			payoutProviders: [
				"sim_ewallet_ph",
				"tazapay_sandbox",
				"blindpay_sandbox",
			],
		}),
		corridor(["US", "USD"], ["PH", "PHP"], {
			payoutProviders: ["blindpay_sandbox"],
		}),
		corridor(["DE", "EUR"], ["PH", "PHP"], {
			payoutProviders: ["tazapay_sandbox"],
		}),
		corridor(["GB", "GBP"], ["PH", "USD"], {
			payoutProviders: ["other_sandbox"],
		}),
		corridor(["GB", "GBP"], ["BR", "BRL"], {
			payoutProviders: ["sim_bank_br_pix"],
		}),
		corridor(["GB", "GBP"], ["KE", "KES"]),
		corridor(["GB", "GBP"], ["AR", "ARS"], {
			payoutProviders: ["tazapay_sandbox"],
		}),
	]

	test("by source: first sandbox id wins per country; non GBP/USD sources ignored", () => {
		const bySource = sandboxPayoutsBySource(corridors)
		assert.deepEqual(
			bySource.GBP.map((r) => [r.code, r.providerName]),
			[
				["AR", "Tazapay"],
				["PH", "Tazapay"],
			],
		)
		assert.deepEqual(
			bySource.USD.map((r) => [r.code, r.providerId]),
			[["PH", "blindpay_sandbox"]],
		)
	})

	test("world list merges send currencies (pounds first) and partners (sorted)", () => {
		const world = sandboxPayoutsWorld(corridors)
		assert.deepEqual(
			world.map((r) => r.code),
			["AR", "PH"],
		)
		const ph = world[1]
		assert.deepEqual(ph?.from, ["GBP", "USD", "EUR"])
		assert.deepEqual(
			ph?.partners.map((p) => p.id),
			["blindpay_sandbox", "other_sandbox", "tazapay_sandbox"],
		)
		assert.equal(ph?.partners[2]?.name, "Tazapay")
		assert.equal(ph?.name, "Philippines")
	})

	test("world list sorts unranked currencies alphabetically", () => {
		const world = sandboxPayoutsWorld([
			corridor(["JP", "JPY"], ["PH", "PHP"], {
				payoutProviders: ["a_sandbox"],
			}),
			corridor(["DE", "EUR"], ["PH", "PHP"], {
				payoutProviders: ["a_sandbox"],
			}),
		])
		assert.deepEqual(world[0]?.from, ["EUR", "JPY"])
	})
})

describe("summarizeCorridor", () => {
	test("keeps known endpoint types and optional legs", () => {
		const summary = summarizeCorridor({
			from: { country: "GB", currency: "GBP" },
			to: { country: "PH", currency: "PHP" },
			allowedDestinationTypes: [
				"bank_account",
				"crypto_custodial",
				"cash_pickup",
			],
			recipientKinds: ["individual"],
			regulationNote: "n",
			simulated: false,
			settleRails: ["solana_tgbp"],
			payoutProviders: ["tazapay_sandbox"],
		})
		assert.deepEqual(summary.allowedDestinationTypes, [
			"bank_account",
			"crypto_custodial",
		])
		assert.deepEqual(summary.settleRails, ["solana_tgbp"])
		assert.deepEqual(summary.payoutProviders, ["tazapay_sandbox"])
		assert.equal(summary.simulated, false)

		const bare = summarizeCorridor({
			from: { country: "US", currency: "USD" },
			to: { country: "PH", currency: "PHP" },
			allowedDestinationTypes: [],
			recipientKinds: [],
			regulationNote: "",
			simulated: true,
		})
		assert.equal("settleRails" in bare, false)
		assert.equal("payoutProviders" in bare, false)
	})
})
