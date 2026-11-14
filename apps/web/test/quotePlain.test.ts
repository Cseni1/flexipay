import assert from "node:assert/strict"
import { type Quote } from "@flexipay/web-lib/contract"
import { describe, it } from "vitest"
import { plainStep, rateLine } from "../src/payments/quotePlain"

const leg = (
	kind: Quote["route"][number]["kind"],
	rail: string,
	currency: string,
): Quote["route"][number] => ({
	kind,
	rail,
	providerId: rail,
	amountIn: { amount: "100", currency },
	amountOut: { amount: "100", currency },
	simulated: true,
})

const quote = (overrides: Partial<Quote> = {}): Quote =>
	({
		source: { type: "bank_account", currency: "GBP", country: "GB" },
		destination: {
			type: "bank_account",
			currency: "PHP",
			country: "PH",
			recipientKind: "individual",
		},
		amount: { side: "send", value: { amount: "10000", currency: "GBP" } },
		expectedReceive: { amount: "777193", currency: "PHP" },
		fxRate: "77.7193000",
		route: [],
		...overrides,
	}) as unknown as Quote

describe("plainStep", () => {
	it("describes every leg without rail ids", () => {
		const q = quote()
		assert.equal(
			plainStep(leg("collect", "sim_bank_gb_fps", "GBP"), q),
			"We collect your money from your bank",
		)
		assert.equal(
			plainStep(leg("convert", "sim_fx_gbp_tgbp", "TGBP"), q),
			"Changed into digital pounds",
		)
		assert.equal(
			plainStep(leg("convert", "sim_fx", "USDC"), q),
			"Changed into digital dollars",
		)
		assert.equal(
			plainStep(leg("convert", "tazapay_sandbox", "PHP"), q),
			"Changed into PHP",
		)
		assert.equal(
			plainStep(leg("settle", "solana_tgbp", "TGBP"), q),
			"Moved on Solana in seconds",
		)
		assert.equal(
			plainStep(leg("settle", "stellar_usdc", "USDC"), q),
			"Moved on Stellar in seconds",
		)
		assert.equal(
			plainStep(leg("payout", "tazapay_sandbox", "PHP"), q),
			"Tazapay pays it into their bank",
		)
	})

	it("uses wallet words for wallet sources and destinations", () => {
		const q = quote({
			source: { type: "crypto_wallet", currency: "USDC", country: "US" },
			destination: {
				type: "ewallet",
				currency: "PHP",
				country: "PH",
				recipientKind: "individual",
			},
		} as Partial<Quote>)
		assert.equal(
			plainStep(leg("collect", "solana_usdc", "USDC"), q),
			"We collect your money from your wallet",
		)
		assert.equal(
			plainStep(leg("payout", "blindpay_sandbox", "PHP"), q),
			"BlindPay pays it into their e-wallet",
		)
		assert.equal(
			plainStep(leg("settle", "other_chain", "USDC"), q),
			"Moved on the network in seconds",
		)
	})
})

describe("rateLine", () => {
	it("shows one unit of the send currency in the receive currency", () => {
		assert.equal(rateLine(quote()), "1 GBP = 77.7193 PHP")
	})

	it("is hidden without a conversion or with a bad rate", () => {
		assert.equal(rateLine(quote({ fxRate: null } as Partial<Quote>)), null)
		assert.equal(rateLine(quote({ fxRate: "abc" } as Partial<Quote>)), null)
		assert.equal(
			rateLine(
				quote({
					expectedReceive: { amount: "10000", currency: "GBP" },
				} as Partial<Quote>),
			),
			null,
		)
	})
})
