import { expect, test, type Page } from "@playwright/test"
import {
	paymentDetailFixture,
	paymentFromDetail,
	quoteFixture,
	openQuoteDetails,
} from "./fixtures"

// TASK 26: Demo Day aggregator saving on quote, detail, list, and dashboard.
// Fixture coverage only — the browser intercepts the API.

const noSideways = async (page: Page) => {
	const metrics = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}))
	expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth)
}

const partnerAlt = (receivePhp: string) => ({
	route: [
		{
			kind: "collect" as const,
			rail: "sim_bank_us_ach",
			providerId: "sim_bank_us_ach",
			amountIn: { amount: "125000", currency: "USD" },
			amountOut: { amount: "125000", currency: "USD" },
			simulated: true,
		},
		{
			kind: "payout" as const,
			rail: "blindpay_sandbox",
			providerId: "blindpay_sandbox",
			amountIn: { amount: receivePhp, currency: "PHP" },
			amountOut: { amount: receivePhp, currency: "PHP" },
			simulated: true,
		},
	],
	totalCost: { amount: "4500", currency: "USD" },
	estimatedTimeSeconds: 120,
	reasons: ["Partner payout is available for this recipient kind."],
})

const quoteWithSaving = () => {
	const base = quoteFixture()
	return {
		...base,
		expectedReceive: { amount: "6625000", currency: "PHP" },
		alternatives: [partnerAlt("6500000")],
	}
}

const quoteEqualRoutes = () => {
	const base = quoteFixture()
	return {
		...base,
		expectedReceive: { amount: "6625000", currency: "PHP" },
		alternatives: [partnerAlt("6625000")],
	}
}

async function mockSendFlow(
	page: Page,
	quote: ReturnType<typeof quoteWithSaving>,
) {
	await page.route(/\/v1\/recipients$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback()
		await route.fulfill({ json: { id: "rcp_1" } })
	})
	await page.route(/\/v1\/quotes$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback()
		await route.fulfill({ json: quote })
	})
	await page.route(/\/v1\/quotes\/quo_1$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ json: quote })
	})
	await page.route(/\/v1\/payments$/, async (route) => {
		if (route.request().method() === "POST") {
			await route.fulfill({
				json: paymentFromDetail(paymentDetailFixture("awaiting_funding")),
			})
			return
		}
		if (route.request().method() === "GET") {
			await route.fulfill({
				json: {
					payments: [
						paymentFromDetail(paymentDetailFixture("awaiting_funding")),
					],
				},
			})
			return
		}
		return route.fallback()
	})
	await page.route(/\/v1\/payments\/pay_1$/, async (route) => {
		await route.fulfill({
			json: paymentDetailFixture("awaiting_funding"),
		})
	})
}

async function fillQuoteForm(page: Page) {
	await page.getByLabel("Destination country").selectOption("PH")
	await page.getByLabel("Destination", { exact: true }).selectOption("ewallet")
	await page.getByLabel("Recipient kind").selectOption("individual")
	await page.getByLabel("Who pays the fee?").selectOption("PayerPays")
	await page.getByLabel("Amount (USD)").fill("1,250.00")
	await page.getByLabel("Recipient", { exact: true }).fill("Worker A")
}

test.describe("TASK 26 aggregator saving", () => {
	test("a better partner route shows the saving with amount and currency", async ({
		page,
	}) => {
		await mockSendFlow(page, quoteWithSaving())
		await page.goto("/")
		await fillQuoteForm(page)
		await page.getByRole("button", { name: "Get quote" }).click()
		const saving = page.getByTestId("aggregator-saving")
		await expect(saving).toBeVisible()
		await expect(saving).toContainText("1,250.00 PHP")
		await expect(saving).toContainText("BlindPay")
		await expect(saving).toContainText("more than the next best route")
	})

	test("equal routes hide the aggregator saving", async ({ page }) => {
		await mockSendFlow(page, quoteEqualRoutes())
		await page.goto("/")
		await fillQuoteForm(page)
		await page.getByRole("button", { name: "Get quote" }).click()
		await openQuoteDetails(page)
		await expect(page.getByTestId("why-this-route")).toBeVisible()
		await expect(page.getByTestId("aggregator-saving")).toHaveCount(0)
	})

	test("payment detail and dashboard show the saving", async ({ page }) => {
		await mockSendFlow(page, quoteWithSaving())
		await page.goto("/")
		await fillQuoteForm(page)
		await page.getByRole("button", { name: "Get quote" }).click()
		await expect(page.getByTestId("aggregator-saving")).toBeVisible()
		await page.getByTestId("create-payment").click()
		await expect(page).toHaveURL(/\/payments\/pay_1$/)
		const detailSaving = page.getByTestId("payment-saving")
		await expect(detailSaving).toBeVisible()
		await expect(detailSaving).toContainText("Saved 1,250.00 PHP vs next best")

		await page.goto("/dashboard")
		const dashboard = page.getByTestId("dashboard-saved-for-recipients")
		await expect(dashboard).toBeVisible()
		await expect(dashboard).toContainText("Saved for recipients")
		await expect(dashboard).toContainText("1,250.00 PHP")
		await expect(
			page.getByTestId("payment-history").getByTestId("payment-saving"),
		).toContainText("Saved 1,250.00 PHP vs next best")
		await expect(
			page.getByTestId("payment-history-cards").getByTestId("payment-saving"),
		).toContainText("Saved 1,250.00 PHP vs next best")
	})

	test("390px has no sideways scroll on quote, detail, and dashboard", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 })
		await mockSendFlow(page, quoteWithSaving())
		await page.goto("/")
		await fillQuoteForm(page)
		await page.getByRole("button", { name: "Get quote" }).click()
		await expect(page.getByTestId("aggregator-saving")).toBeVisible()
		await noSideways(page)

		await page.getByTestId("create-payment").click()
		await expect(page.getByTestId("payment-saving")).toBeVisible()
		await noSideways(page)

		await page.goto("/dashboard")
		await expect(
			page.getByTestId("dashboard-saved-for-recipients"),
		).toBeVisible()
		// Demo roadmap: what works today vs coming soon, readable on a phone.
		const roadmap = page.getByTestId("dashboard-roadmap")
		await expect(roadmap).toContainText("Quotes from pounds to 63 countries")
		await expect(roadmap.getByText("Working (sandbox)").first()).toBeVisible()
		await expect(roadmap.getByText("Coming soon").first()).toBeVisible()
		await noSideways(page)
	})
})
