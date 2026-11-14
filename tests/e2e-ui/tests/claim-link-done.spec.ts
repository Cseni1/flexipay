import { expect, test, type Page } from "@playwright/test"
import { paymentDetailFixture } from "./fixtures"

// The "send them the claim link" step only shows while the money is still moving.

const claimLink = {
	url: "http://api.local/v1/claims/claim_token_1",
	expiresAt: new Date(Date.now() + 120_000).toISOString(),
}

async function mockDetail(page: Page, status: "processing" | "paid") {
	const detail = paymentDetailFixture("processing")
	await page.route(/\/v1\/payments\/pay_1$/, async (route) => {
		await route.fulfill({
			json: { ...detail, status, delivery: "claim_link", claimLink },
		})
	})
}

test.describe("claim link next step", () => {
	test("shows while the payment is on its way", async ({ page }) => {
		await mockDetail(page, "processing")
		await page.goto("/payments/pay_1")
		await expect(
			page.getByRole("heading", { name: "Send them the claim link" }),
		).toBeVisible()
	})

	test("is gone once the payment is delivered", async ({ page }) => {
		await mockDetail(page, "paid")
		await page.goto("/payments/pay_1")
		await expect(
			page.getByText("Delivered", { exact: true }).first(),
		).toBeVisible()
		await expect(
			page.getByRole("heading", { name: "Send them the claim link" }),
		).toHaveCount(0)
		await expect(page.getByTestId("claim-link-gone")).toHaveCount(0)
	})
})
