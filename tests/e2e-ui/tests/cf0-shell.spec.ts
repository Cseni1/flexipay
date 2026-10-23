import { test, expect } from "@playwright/test"

test.describe("CF0 web shell", () => {
	test("send payment screen uses the shared shell", async ({ page }) => {
		await page.goto("/")

		await expect(page.getByRole("heading", { name: "FlexiPay" })).toBeVisible()
		await expect(
			page.getByRole("heading", { name: "Send a payment" }),
		).toBeVisible()
		await expect(page.getByRole("link", { name: "Payments" })).toBeVisible()
		await expect(page.getByText("Simulated").first()).toBeVisible()
		await expect(page.getByRole("button", { name: "Get quote" })).toBeDisabled()
	})

	test("payment detail shows the status colour key", async ({ page }) => {
		await page.goto("/payments/demo-payment")

		await expect(
			page.getByRole("heading", { name: "Payment detail" }),
		).toBeVisible()
		await expect(
			page.getByRole("heading", { name: "Status key" }),
		).toBeVisible()
		await expect(page.getByText("Completed", { exact: true })).toBeVisible()
		await expect(page.getByText("Expired", { exact: true })).toBeVisible()
		await expect(page.getByText("Refunded", { exact: true })).toBeVisible()
	})

	test("claim page works at phone width", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 })
		await page.goto("/claim/demo-claim")

		await expect(
			page.getByRole("heading", { name: "Claim your payment" }),
		).toBeVisible()
		await expect(page.getByText("Simulated").first()).toBeVisible()
		await expect(
			page.getByRole("button", { name: "Accept payment" }),
		).toBeDisabled()
		await expect(
			page.getByRole("radio", { name: /Crypto wallet/ }),
		).toBeChecked()
	})

	test("the (i) explanation opens", async ({ page }) => {
		await page.goto("/")
		await page
			.getByRole("button", { name: "More information: Route selection" })
			.click()

		await expect(page.getByRole("note")).toContainText("ineligible")
	})
})
