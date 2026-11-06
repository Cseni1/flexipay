import { expect, test, type Page } from "@playwright/test"
import { quoteFixture } from "./fixtures"

const CORRIDORS = {
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
				payout: ["sim_ewallet_ph", "tazapay_sandbox"],
			},
		},
		{
			from: { country: "GB", currency: "GBP" },
			to: { country: "PH", currency: "PHP" },
			allowedDestinationTypes: ["bank_account", "ewallet", "crypto_wallet"],
			recipientKinds: ["individual", "company"],
			regulationNote: "Cross-border GBP to PHP over tGBP.",
			simulated: true,
			legsAvailable: {
				collect: ["sim_bank_gb_fps"],
				convert: ["sim_fx"],
				settle: ["solana_tgbp"],
				payout: ["tazapay_sandbox"],
			},
		},
		{
			from: { country: "GB", currency: "GBP" },
			to: { country: "KE", currency: "KES" },
			allowedDestinationTypes: ["bank_account"],
			recipientKinds: ["individual", "company"],
			regulationNote: "Cross-border GBP to KES via Tazapay sandbox.",
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

async function mockTask20(page: Page) {
	const state = {
		quoteBodies: [] as Array<Record<string, unknown>>,
	}

	await page.route(/\/v1\/corridors$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ json: CORRIDORS })
	})
	await page.route(/\/v1\/recipients$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ json: { recipients: [] } })
	})
	await page.route(/\/v1\/quotes$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback()
		const body = route.request().postDataJSON() as Record<string, unknown>
		state.quoteBodies.push(body)
		const source = body.source as { currency?: string; country?: string }
		const base = quoteFixture()
		await route.fulfill({
			json: {
				...base,
				source: body.source,
				destination: body.destination,
				amount: body.amount,
				fees: {
					...base.fees,
					total: {
						amount: "10",
						currency: source.currency === "GBP" ? "GBP" : "USD",
					},
				},
			},
		})
	})

	return state
}

async function fillQuoteBasics(page: Page) {
	await page.getByLabel("Who pays the fee? (Vault fee payer)").selectOption({
		label: "I pay the fee (added on top)",
	})
	await page.getByRole("textbox", { name: "Recipient" }).fill("Worker A")
}

test.describe("TASK 20 Send from and sandbox coverage", () => {
	test("a country picked before corridors load still defaults to GBP once they arrive", async ({
		page,
	}) => {
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		await page.route(/\/v1\/corridors$/, async (route) => {
			if (route.request().method() !== "GET") return route.fallback()
			await gate
			await route.fulfill({ json: CORRIDORS })
		})
		await page.route(/\/v1\/recipients$/, async (route) => {
			if (route.request().method() !== "GET") return route.fallback()
			await route.fulfill({ json: { recipients: [] } })
		})
		await page.goto("/")
		// PH is in the built-in fallback list, so it can be chosen while corridors are still loading.
		await page.getByLabel("Destination country").selectOption("PH")
		release()
		const sendFrom = page.getByLabel("Send from")
		await expect(sendFrom).toHaveValue("GB:GBP")
		await expect(page.getByLabel("Amount (£)")).toBeVisible()
	})

	test("PH shows Send from, defaults to GBP, USD switch updates the quote", async ({
		page,
	}) => {
		const state = await mockTask20(page)
		await page.goto("/")

		await page.getByLabel("Destination country").selectOption("PH")
		const sendFrom = page.getByLabel("Send from")
		await expect(sendFrom).toBeVisible()
		await expect(sendFrom).toHaveValue("GB:GBP")
		await expect(page.getByLabel("Amount (£)")).toBeVisible()
		await expect(
			page.getByText("Cross-border GBP to PHP over tGBP."),
		).toBeVisible()

		await fillQuoteBasics(page)
		await page.getByLabel("Amount (£)").fill("10.00")
		await page.getByRole("button", { name: "Get quote" }).click()
		await expect.poll(() => state.quoteBodies.length).toBeGreaterThanOrEqual(1)
		expect(state.quoteBodies[0]?.source).toEqual({
			type: "bank_account",
			currency: "GBP",
			country: "GB",
		})

		await sendFrom.selectOption("US:USD")
		await expect(page.getByLabel("Amount (USD)")).toBeVisible()
		await expect(page.getByText("Cross-border USD to PHP.")).toBeVisible()
		await page.getByLabel("Amount (USD)").fill("12.50")
		await page.getByRole("button", { name: "Get quote" }).click()
		await expect.poll(() => state.quoteBodies.length).toBeGreaterThanOrEqual(2)
		expect(state.quoteBodies.at(-1)?.source).toEqual({
			type: "bank_account",
			currency: "USD",
			country: "US",
		})
	})

	test("KE keeps a static Source and quotes GBP only", async ({ page }) => {
		const state = await mockTask20(page)
		await page.goto("/")

		await page.getByLabel("Destination country").selectOption("KE")
		await expect(page.getByLabel("Send from")).toHaveCount(0)
		await expect(page.getByText("GBP bank account")).toBeVisible()
		await expect(page.getByText("Set by destination country")).toBeVisible()
		await expect(page.getByLabel("Amount (£)")).toBeVisible()

		await fillQuoteBasics(page)
		await page.getByLabel("Amount (£)").fill("10.00")
		await page.getByRole("button", { name: "Get quote" }).click()
		await expect.poll(() => state.quoteBodies.length).toBeGreaterThanOrEqual(1)
		expect(state.quoteBodies[0]?.source).toEqual({
			type: "bank_account",
			currency: "GBP",
			country: "GB",
		})
	})

	test("Where we pay lists Kenya under From GBP with Tazapay Sandbox", async ({
		page,
	}) => {
		await mockTask20(page)
		await page.goto("/where-we-pay")

		await expect(
			page.getByRole("heading", { name: "Where we pay" }),
		).toBeVisible()
		await expect(page.getByTestId("coverage-disclaimer")).toContainText(
			"not live payments",
		)
		await expect(
			page.getByRole("heading", { name: "Priced live in sandbox" }),
		).toBeVisible()

		const fromGbp = page.getByTestId("sandbox-from-gbp")
		await expect(fromGbp.getByText("Kenya")).toBeVisible()
		const kenya = fromGbp.getByTestId("sandbox-country-KE")
		await expect(kenya.getByText("Tazapay")).toBeVisible()
		await expect(kenya.getByTestId("provider-badge")).toHaveText("Sandbox")
	})

	test("390px: Send and Where we pay do not scroll sideways", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 })
		await mockTask20(page)

		const noSideways = async () => {
			const metrics = await page.evaluate(() => ({
				scrollWidth: document.documentElement.scrollWidth,
				innerWidth: window.innerWidth,
			}))
			expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth)
		}

		await page.goto("/")
		await page.getByLabel("Destination country").selectOption("PH")
		await expect(page.getByLabel("Send from")).toBeVisible()
		await noSideways()

		await page.goto("/where-we-pay")
		await expect(page.getByTestId("sandbox-from-gbp")).toBeVisible()
		await noSideways()
	})
})
