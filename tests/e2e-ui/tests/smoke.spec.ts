import { test, expect } from "@playwright/test"

// Smoke check that the web app mounts and labels simulated providers. No chain or wallet needed.

test("home page mounts", async ({ page }) => {
	const response = await page.goto("/")
	expect(response?.ok()).toBeTruthy()
	await expect(page.getByRole("heading", { name: "FlexiPay" })).toBeVisible()
})

test("simulated providers are labelled", async ({ page }) => {
	await page.goto("/")
	await expect(page.getByText(/simulated/i).first()).toBeVisible()
})
