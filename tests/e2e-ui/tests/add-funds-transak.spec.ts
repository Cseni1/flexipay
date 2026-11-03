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
		// Playwright webServer does not set VITE_TRANSAK_STAGING_KEY.
		await expect(page.getByTestId("add-funds-unconfigured")).toHaveText(
			"Add funds isn't configured",
		)
		await expect(page.getByTestId("add-funds-open")).toHaveCount(0)
		await expect(page.getByTestId("add-funds-connect-first")).toHaveCount(0)
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
