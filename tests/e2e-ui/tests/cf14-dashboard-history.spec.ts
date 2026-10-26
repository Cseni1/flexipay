import { expect, test, type Page } from "@playwright/test"
import { paymentDetailFixture, paymentFromDetail } from "./fixtures"

// CF14: dashboard, payment history and developers pages read the real v1 list route.
// Fixture coverage only: the browser tests intercept the request.

const listOf = () => {
	const base = paymentFromDetail(paymentDetailFixture("awaiting_funding"))
	return {
		payments: [
			{ ...base, id: "pay_new", status: "awaiting_funding" },
			{ ...base, id: "pay_moving", status: "processing" },
			{ ...base, id: "pay_done", status: "paid" },
			{ ...base, id: "pay_back", status: "refunded" },
		],
	}
}

async function mock(page: Page, list: unknown = listOf(), status = 200) {
	await page.route(/\/v1\/payments$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ status, json: list })
	})
}

test.describe("CF14 dashboard and history", () => {
	test("the dashboard counts and lists real payments", async ({ page }) => {
		await mock(page)
		await page.goto("/dashboard")
		const stats = page.getByTestId("dashboard-stats")
		await expect(stats).toContainText("4")
		await expect(stats).toContainText("In flight")
		await expect(page.getByTestId("payment-history")).toContainText("pay_done")
		await page.getByRole("link", { name: "pay_done" }).click()
		await expect(page).toHaveURL(/\/payments\/pay_done$/)
	})

	test("history filters by status and searches by id", async ({ page }) => {
		await mock(page)
		await page.goto("/payments")
		await expect(page.locator("tbody tr")).toHaveCount(4)
		await page.getByRole("button", { name: "Refunded or failed" }).click()
		await expect(page.locator("tbody tr")).toHaveCount(1)
		await expect(page.getByTestId("payment-history")).toContainText("pay_back")
		await page.getByRole("button", { name: "All" }).click()
		await page.getByLabel("Search payments").fill("moving")
		await expect(page.locator("tbody tr")).toHaveCount(1)
	})

	test("an empty history and an API failure are explained", async ({ page }) => {
		await mock(page, { payments: [] })
		await page.goto("/payments")
		await expect(page.getByText("No payments match")).toBeVisible()

		const failing = await page.context().newPage()
		await mock(failing, { code: "internal_error", message: "boom" }, 500)
		await failing.goto("/dashboard")
		await expect(failing.getByTestId("dashboard-error")).toBeVisible()
	})

	test("the sidebar reaches every page and developers copies the quickstart", async ({
		page,
		context,
		baseURL,
	}) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"], {
			origin: new URL(baseURL ?? "http://localhost").origin,
		})
		await mock(page)
		await page.goto("/")
		const nav = page.getByRole("navigation", { name: "Primary" })
		for (const name of ["Dashboard", "Payments", "New payment", "Developers"]) {
			await expect(nav.getByRole("link", { name })).toBeVisible()
		}
		await nav.getByRole("link", { name: "Developers" }).click()
		await page.getByRole("button", { name: "Copy" }).first().click()
		await expect(page.getByRole("status").first()).toContainText("Copied")
		const text = await page.evaluate(() => navigator.clipboard.readText())
		expect(text).toContain("/v1/quotes")
		expect(text).toContain("--oauth2-bearer")
	})
})
