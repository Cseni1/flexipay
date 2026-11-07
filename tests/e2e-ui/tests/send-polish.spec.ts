import { expect, test, type Page } from "@playwright/test"
import { quoteFixture } from "./fixtures"

const corridorsWithGb = {
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
			regulationNote: "UK GBP to tGBP.",
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

async function mockSendPolish(page: Page) {
	await page.route(/\/v1\/corridors$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ json: corridorsWithGb })
	})
	await page.route(/\/v1\/recipients$/, async (route) => {
		if (route.request().method() === "GET") {
			await route.fulfill({
				json: {
					recipients: [
						{
							id: "rcp_ph",
							name: "Worker PH",
							kind: "individual",
							country: "PH",
							createdAt: "2026-11-01T12:00:00.000Z",
						},
					],
				},
			})
			return
		}
		return route.fallback()
	})
	await page.route(/\/v1\/quotes$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback()
		const base = quoteFixture()
		await route.fulfill({
			json: {
				...base,
				fees: {
					legs: [
						{
							kind: "settle",
							rail: "solana_tgbp",
							fee: { amount: "1000000", currency: "TGBP" },
						},
					],
					flexiPayFee: { amount: "1000000", currency: "TGBP" },
					total: { amount: "9", currency: "GBP" },
					settleUnlockedRemainder: {
						amount: "10000000",
						currency: "TGBP",
					},
				},
				reasons: [
					"PayerPays settle remainder 10000000 TGBP stays unlocked (not a fee; CCR-8/CCR-13)",
				],
			},
		})
	})
}

test.describe("Send form polish", () => {
	test("source caption, recipient country note, fee total and unlocked £ reason", async ({
		page,
	}) => {
		await mockSendPolish(page)
		await page.goto("/")

		// Before a country is chosen the sender picks Send from; pounds are the default.
		await expect(page.getByLabel("Send from")).toHaveValue("GB:GBP")

		await page.getByLabel("Destination country").selectOption("GB")
		await page.getByLabel("Saved recipient").selectOption("rcp_ph")
		await expect(page.getByTestId("recipient-country-note")).toHaveText(
			"Country changed to Philippines to match this recipient",
		)
		await expect(page.getByLabel("Destination country")).toHaveValue("PH")

		await page.getByLabel("Destination", { exact: true }).selectOption("ewallet")
		await page.getByLabel("Recipient kind").selectOption("individual")
		await page.getByLabel("Vault fee payer").selectOption("PayerPays")
		await page.getByLabel("Amount (USD)").fill("10.00")
		await page.getByRole("button", { name: "Get quote" }).click()

		await expect(page.getByText("All fees")).toBeVisible()
		// The settle fee and FlexiPay fee are the same £0.10 listed twice: the total
		// must count it once (£0.10), never double (£0.20) or the floored API £0.09.
		await expect(page.getByText("£0.20")).toHaveCount(0)
		await expect(page.getByText("£0.09")).toHaveCount(0)
		await expect(page.getByText("£0.10").last()).toBeVisible()
		await expect(
			page.getByText(/remainder £1\.00 stays unlocked/),
		).toBeVisible()
		await expect(page.getByText(/10000000 TGBP/)).toHaveCount(0)
	})
})
