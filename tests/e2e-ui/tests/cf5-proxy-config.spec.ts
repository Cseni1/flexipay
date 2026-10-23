import { test, expect } from "@playwright/test"

// This test does not intercept /v1: it exercises the real Vite proxy with the webServer's
// deliberately empty FP_API_KEY. The browser must get an honest config error, not a fake
// quote or a request with a browser-side key.
test("missing server-side FP_API_KEY is reported honestly", async ({
	page,
}) => {
	await page.goto("/")
	await page.getByLabel("Destination country").selectOption("PH")
	await page.getByLabel("Destination", { exact: true }).selectOption("ewallet")
	await page.getByLabel("Recipient kind").selectOption("individual")
	await page.getByLabel("Vault fee payer").selectOption("PayerPays")
	await page.getByLabel("Amount (USD)").fill("1.00")
	await page.getByLabel("Recipient", { exact: true }).fill("Worker A")

	await page.getByRole("button", { name: "Get quote" }).click()

	await expect(page.getByText(/local web proxy/i).first()).toBeVisible()
	await expect(page.getByText(/FP_API_KEY/).first()).toBeVisible()
	await expect(
		page.getByRole("button", { name: "Authentication required" }),
	).toBeDisabled()
})
