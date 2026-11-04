import { expect, test } from "@playwright/test"

test.describe("Pay-from Add funds (Transak staging)", () => {
	test("shows TEST MODE badge and requires a wallet when key is missing", async ({
		page,
	}) => {
		await page.goto("/pay-from")
		const panel = page.getByTestId("add-funds-panel")
		await expect(panel).toBeVisible()
		await expect(page.getByTestId("add-funds-test-badge")).toHaveText(
			/TEST MODE:\s*no real money/i,
		)
		await expect(page.getByLabel("Where are you buying from?")).toBeVisible()
		// Playwright webServer does not set VITE_TRANSAK_STAGING_KEY.
		await expect(page.getByTestId("add-funds-unconfigured")).toHaveText(
			"Add funds isn't configured",
		)
		await expect(page.getByTestId("add-funds-open")).toHaveCount(0)
		await expect(page.getByTestId("add-funds-connect-first")).toHaveCount(0)
		// Crossmint client key is set for e2e; without a wallet it asks to connect.
		await expect(page.getByTestId("crossmint-test-badge")).toHaveText(/TEST/i)
		await expect(page.getByTestId("crossmint-connect-first")).toHaveText(
			"Connect a wallet first",
		)
	})

	test("hides Add funds for GB and ZA", async ({ page }) => {
		await page.goto("/pay-from")
		const country = page.getByLabel("Where are you buying from?")
		await country.selectOption("GB")
		await expect(page.getByTestId("add-funds-country-blocked")).toHaveText(
			"Buying crypto isn't available in your country yet.",
		)
		await expect(page.getByTestId("add-funds-open")).toHaveCount(0)
		await expect(page.getByTestId("add-funds-transak")).toHaveCount(0)
		await expect(page.getByTestId("add-funds-crossmint")).toHaveCount(0)

		await country.selectOption("ZA")
		await expect(page.getByTestId("add-funds-country-blocked")).toHaveText(
			"Buying crypto isn't available in your country yet.",
		)
		await expect(page.getByTestId("add-funds-crossmint")).toHaveCount(0)

		await country.selectOption("US")
		await expect(page.getByTestId("add-funds-country-blocked")).toHaveCount(0)
		await expect(page.getByTestId("add-funds-unconfigured")).toBeVisible()
		await expect(page.getByTestId("add-funds-crossmint")).toBeVisible()
	})

	test("Add funds panel remains usable at 390px", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 })
		await page.goto("/pay-from")
		await expect(page.getByTestId("add-funds-panel")).toBeVisible()
		await expect(page.getByTestId("add-funds-test-badge")).toBeVisible()
		const overflow = await page.evaluate(
			() =>
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth + 1,
		)
		expect(overflow).toBe(false)
	})
})
