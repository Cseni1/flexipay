import { expect, test, type Page } from "@playwright/test"
import { paymentDetailFixture, paymentFromDetail } from "./fixtures"

// CCR-26: UK GBP → tGBP crypto wallet on the send form. Fixture coverage only.

const GB_CORRIDORS = {
	corridors: [
		{
			from: { country: "US", currency: "USD" },
			to: { country: "PH", currency: "PHP" },
			allowedDestinationTypes: ["bank_account", "ewallet", "crypto_wallet"],
			recipientKinds: ["individual", "company"],
			regulationNote: "Cross-border USD to PHP.",
			simulated: true,
			legsAvailable: {
				collect: ["sim_bank_us_ach"],
				convert: ["sim_fx"],
				settle: ["stellar_usdc"],
				payout: ["sim_ewallet_ph"],
			},
		},
		{
			from: { country: "GB", currency: "GBP" },
			to: { country: "GB", currency: "GBP" },
			allowedDestinationTypes: ["crypto_wallet"],
			recipientKinds: ["individual", "company"],
			regulationNote:
				"UK GBP to tGBP (Tokenised GBP) on Solana. Crypto-wallet destination only.",
			simulated: true,
			legsAvailable: {
				collect: ["sim_bank_gb_fps"],
				convert: ["sim_fx_gbp_tgbp"],
				settle: ["solana_tgbp"],
				payout: [],
			},
		},
	],
}

function gbpQuoteFixture() {
	const validUntil = new Date(Date.now() + 120_000).toISOString()
	return {
		id: "quo_gb_1",
		source: { type: "bank_account", currency: "GBP", country: "GB" },
		destination: {
			type: "crypto_wallet",
			currency: "TGBP",
			country: "GB",
			recipientKind: "individual",
		},
		amount: { side: "send", value: { amount: "1000", currency: "GBP" } },
		route: [
			{
				kind: "collect",
				rail: "sim_bank_gb_fps",
				providerId: "sim_bank_gb_fps",
				amountIn: { amount: "1000", currency: "GBP" },
				amountOut: { amount: "1000", currency: "GBP" },
				simulated: true,
			},
			{
				kind: "convert",
				rail: "sim_fx_gbp_tgbp",
				providerId: "sim_fx_gbp_tgbp",
				amountIn: { amount: "1000", currency: "GBP" },
				amountOut: { amount: "100000000", currency: "TGBP" },
				simulated: true,
			},
			{
				kind: "settle",
				rail: "solana_tgbp",
				providerId: "solana_tgbp",
				amountIn: { amount: "100000000", currency: "TGBP" },
				amountOut: { amount: "99000000", currency: "TGBP" },
				simulated: true,
			},
		],
		fees: {
			legs: [
				{
					kind: "collect",
					rail: "sim_bank_gb_fps",
					fee: { amount: "0", currency: "GBP" },
				},
				{
					kind: "convert",
					rail: "sim_fx_gbp_tgbp",
					fee: { amount: "0", currency: "GBP" },
				},
				{
					kind: "settle",
					rail: "solana_tgbp",
					fee: { amount: "1000000", currency: "TGBP" },
				},
			],
			flexiPayFee: { amount: "1000000", currency: "TGBP" },
			total: { amount: "10", currency: "GBP" },
			settleUnlockedRemainder: null,
		},
		fxRate: "1.0000000",
		expectedReceive: { amount: "99000000", currency: "TGBP" },
		priceRiskBearer: "sender",
		policy: "cheapest",
		feeMode: "PayerPays",
		validUntil,
		alternatives: [],
		reasons: ["Crypto-wallet destination on the GB-GB corridor."],
		simulated: true,
	}
}

async function mockUkSend(page: Page) {
	const counts = {
		quotes: 0,
		creates: 0,
		quoteBody: undefined as unknown,
	}

	await page.route(/\/v1\/corridors$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ json: GB_CORRIDORS })
	})
	await page.route(/\/v1\/recipients$/, async (route) => {
		if (route.request().method() === "GET") {
			await route.fulfill({ json: { recipients: [] } })
			return
		}
		if (route.request().method() !== "POST") return route.fallback()
		await route.fulfill({ json: { id: "rcp_gb_1" } })
	})
	await page.route(/\/v1\/quotes$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback()
		counts.quotes += 1
		counts.quoteBody = route.request().postDataJSON()
		await route.fulfill({ json: gbpQuoteFixture() })
	})
	await page.route(/\/v1\/payments$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback()
		counts.creates += 1
		const created = paymentFromDetail(paymentDetailFixture())
		await route.fulfill({
			json: {
				...created,
				id: "pay_1",
				delivery: "claim_link",
				claimLink: {
					url: "http://api.local/v1/claims/claim_token_gb_1",
					expiresAt: new Date(Date.now() + 120_000).toISOString(),
				},
			},
		})
	})
	await page.route(/\/v1\/payments\/pay_1$/, async (route) => {
		await route.fulfill({
			json: {
				...paymentDetailFixture("awaiting_funding"),
				delivery: "claim_link",
			},
		})
	})

	return counts
}

test.describe("UK GBP send (CCR-26)", () => {
	test("United Kingdom quote and claim-link payment use GBP source and TGBP destination", async ({
		page,
	}) => {
		const counts = await mockUkSend(page)
		await page.goto("/")

		await page.getByLabel("Destination country").selectOption("GB")
		await expect(
			page.getByText("GBP bank account", { exact: true }),
		).toBeVisible()
		await expect(page.getByLabel("Destination", { exact: true })).toHaveValue(
			"crypto_wallet",
		)
		const destinationOptions = page.getByLabel("Destination", { exact: true })
		await expect(destinationOptions.locator("option")).toHaveCount(1)
		await expect(destinationOptions.locator("option")).toHaveText(
			/Crypto wallet \(tGBP/,
		)

		await page.getByLabel("Recipient kind").selectOption("individual")
		await page.getByLabel("Who pays the fee?").selectOption("PayerPays")
		await page.getByLabel("Amount (£)").fill("10.00")
		await page.getByLabel("Recipient", { exact: true }).fill("UK Worker")
		await page.getByRole("button", { name: "Get quote" }).click()

		await expect(
			page.getByRole("heading", { name: "Chosen route" }),
		).toBeVisible()
		await expect(page.getByText("£10.00").first()).toBeVisible()
		await expect(
			page.getByText("solana_tgbp", { exact: true }).first(),
		).toBeVisible()
		await expect(page.getByText("PayerPays", { exact: true })).toBeVisible()

		expect(counts.quoteBody).toMatchObject({
			feeMode: "PayerPays",
			source: { type: "bank_account", currency: "GBP", country: "GB" },
			destination: {
				type: "crypto_wallet",
				currency: "TGBP",
				country: "GB",
				recipientKind: "individual",
			},
			amount: { side: "send", value: { amount: "1000", currency: "GBP" } },
		})

		await page.getByRole("radio", { name: "Claim link" }).check()
		await page.getByRole("button", { name: "Create payment" }).click()
		await expect(page).toHaveURL(/\/payments\/pay_1$/)
		await expect(
			page.getByRole("link", { name: "open claim page" }),
		).toBeVisible()
		expect(counts.quotes).toBe(1)
		expect(counts.creates).toBe(1)
	})
})
