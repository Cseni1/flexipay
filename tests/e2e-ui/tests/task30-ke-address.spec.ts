import { expect, test, type Page } from "@playwright/test"

const CORRIDORS = {
	corridors: [
		{
			from: { country: "GB", currency: "GBP" },
			to: { country: "KE", currency: "KES" },
			allowedDestinationTypes: ["bank_account"],
			recipientKinds: ["individual", "company"],
			regulationNote: "Cross-border GBP to KES.",
			simulated: true,
			legsAvailable: {
				collect: ["sim_bank_gb_fps"],
				convert: ["sim_fx_gbp_tgbp"],
				settle: ["solana_tgbp"],
				payout: ["tazapay_sandbox"],
			},
		},
		{
			from: { country: "GB", currency: "GBP" },
			to: { country: "PH", currency: "PHP" },
			allowedDestinationTypes: ["bank_account"],
			recipientKinds: ["individual", "company"],
			regulationNote: "Cross-border GBP to PHP.",
			simulated: true,
			legsAvailable: {
				collect: ["sim_bank_gb_fps"],
				convert: ["sim_fx"],
				settle: ["solana_tgbp"],
				payout: ["tazapay_sandbox"],
			},
		},
	],
}

const KE_REQUIREMENTS = {
	country: "KE",
	currency: "KES",
	providerId: "tazapay_sandbox",
	detailKeys: ["accountNumber", "branchCode"],
	localFields: [
		"address.line1",
		"address.city",
		"address.state",
		"address.postal_code",
	],
	addressRequired: true,
}

const PH_REQUIREMENTS = {
	country: "PH",
	currency: "PHP",
	providerId: "tazapay_sandbox",
	detailKeys: ["accountNumber"],
	localFields: [],
	addressRequired: false,
}

async function mockSend(page: Page) {
	await page.route(/\/v1\/corridors$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ json: CORRIDORS })
	})
	await page.route(/\/v1\/recipients$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ json: { recipients: [] } })
	})
	await page.route(/\/v1\/payout-requirements/, async (route) => {
		const url = new URL(route.request().url())
		const country = url.searchParams.get("country")
		await route.fulfill({
			json: country === "KE" ? KE_REQUIREMENTS : PH_REQUIREMENTS,
		})
	})
}

test.describe("TASK 30 KE recipient address", () => {
	test("Kenya shows address fields and a required branch code", async ({
		page,
	}) => {
		await mockSend(page)
		await page.goto("/")
		await page.getByLabel("Destination country").selectOption("KE")
		await expect(page.getByTestId("recipient-address")).toBeVisible()
		await expect(page.getByLabel("Address line 1 (required)")).toBeVisible()
		await expect(page.getByLabel("City (required)")).toBeVisible()
		await expect(page.getByLabel("State (required)")).toBeVisible()
		await expect(page.getByLabel("Postal code (required)")).toBeVisible()
		await expect(page.getByLabel("Branch code (required)")).toBeVisible()

		await page.getByLabel("Destination country").selectOption("PH")
		await expect(page.getByTestId("recipient-address")).toHaveCount(0)
		await expect(page.getByLabel("Branch code (required)")).toHaveCount(0)
	})
})
