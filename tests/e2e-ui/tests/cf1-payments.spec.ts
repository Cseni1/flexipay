import { test, expect, type Page } from "@playwright/test"
import {
	paymentDetailFixture,
	paymentFromDetail,
	quoteFixture,
} from "./fixtures"

interface MockOptions {
	quote?: ReturnType<typeof quoteFixture>
	quoteError?: { status: number; body: unknown }
	quoteDelayMs?: number
	createDelayMs?: number
	startProcessing?: boolean
	detailStatus?: "failed"
	detail?: ReturnType<typeof paymentDetailFixture>
	createClaimLink?: boolean
}

async function mockApi(page: Page, options: MockOptions = {}) {
	const counts = {
		recipients: 0,
		quotes: 0,
		creates: 0,
		details: 0,
		funds: 0,
		paymentKey: "",
		fundKey: "",
		quoteBody: undefined as unknown,
		quoteAuthHeader: undefined as string | undefined,
		createAuthHeader: undefined as string | undefined,
	}
	let funded = options.startProcessing ?? false

	await page.route(/\/v1\/recipients$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback()
		counts.recipients += 1
		await route.fulfill({ json: { id: "rcp_1" } })
	})

	await page.route(/\/v1\/quotes$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback()
		counts.quotes += 1
		counts.quoteBody = route.request().postDataJSON()
		counts.quoteAuthHeader = route.request().headers()["authorization"]
		if (options.quoteDelayMs) {
			await new Promise((resolve) => setTimeout(resolve, options.quoteDelayMs))
		}
		if (options.quoteError) {
			await route.fulfill({
				status: options.quoteError.status,
				json: options.quoteError.body,
			})
			return
		}
		await route.fulfill({ json: options.quote ?? quoteFixture() })
	})

	await page.route(/\/v1\/payments$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback()
		counts.creates += 1
		counts.paymentKey = route.request().headers()["idempotency-key"] ?? ""
		counts.createAuthHeader = route.request().headers()["authorization"]
		if (options.createDelayMs) {
			await new Promise((resolve) => setTimeout(resolve, options.createDelayMs))
		}
		const created = paymentFromDetail(paymentDetailFixture())
		await route.fulfill({
			json: options.createClaimLink
				? {
						...created,
						claimLink: {
							url: "http://api.local/v1/claims/claim_token_1",
							expiresAt: new Date(Date.now() + 120_000).toISOString(),
						},
					}
				: created,
		})
	})

	await page.route(/\/v1\/payments\/pay_1$/, async (route) => {
		counts.details += 1
		await route.fulfill({
			json:
				options.detail ??
				paymentDetailFixture(
					funded ? "processing" : (options.detailStatus ?? "awaiting_funding"),
				),
		})
	})

	await page.route(/\/v1\/payments\/pay_1\/fund$/, async (route) => {
		counts.funds += 1
		counts.fundKey = route.request().headers()["idempotency-key"] ?? ""
		funded = true
		await route.fulfill({
			json: paymentFromDetail(paymentDetailFixture("processing")),
		})
	})

	return counts
}

async function fillQuoteForm(page: Page) {
	await page.getByLabel("Destination country").selectOption("PH")
	await page.getByLabel("Destination", { exact: true }).selectOption("ewallet")
	await page.getByLabel("Recipient kind").selectOption("individual")
	await page.getByLabel("Vault fee payer").selectOption("PayerPays")
	await page.getByLabel("Amount (USD)").fill("1,250.00")
	await page.getByLabel("Recipient", { exact: true }).fill("Worker A")
}

test.describe("CF1 payments", () => {
	test("quote, create, fund and detail from A0-shaped fixtures", async ({
		page,
	}) => {
		const counts = await mockApi(page)
		await page.goto("/")
		await expect(page.getByText("No quote yet")).toBeVisible()
		await fillQuoteForm(page)
		await page.getByRole("button", { name: "Get quote" }).click()

		await expect(page.getByText("1,250.00 USD")).toBeVisible()
		await expect(page.getByText("66,250.00 PHP")).toBeVisible()
		await expect(page.getByText("55.50")).toBeVisible()
		await expect(page.getByText(/Quote is valid for/)).toBeVisible()
		await expect(
			page.getByText(
				"E-wallet payout is available for individuals in this corridor.",
			),
		).toBeVisible()
		await expect(
			page.getByText("Bank payout is available for this recipient kind."),
		).toBeVisible()
		await expect(
			page.getByRole("heading", { name: "Chosen route" }),
		).toBeVisible()
		await expect(page.getByText("PayerPays", { exact: true })).toBeVisible()
		expect(counts.quoteBody).toMatchObject({
			feeMode: "PayerPays",
			destination: { type: "ewallet", country: "PH" },
		})
		await expect(
			page.getByText("stellar_usdc", { exact: true }).first(),
		).toBeVisible()

		await page.getByRole("button", { name: "Create payment" }).click()
		await expect(page).toHaveURL(/\/payments\/pay_1$/)
		await expect(
			page.getByText("Awaiting funding", { exact: true }).first(),
		).toBeVisible()
		await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible()
		await expect(page.getByText("Collect", { exact: true })).toBeVisible()

		await page.getByRole("button", { name: "Fund payment" }).click()
		await expect(
			page.getByText("Processing", { exact: true }).first(),
		).toBeVisible()
		await expect(page.getByText(/a1b2c3d4e5f6/).first()).toBeVisible()
		await expect(page.getByText("payout_1234567890").first()).toBeVisible()
		await expect(page.getByText(/Release tx/).first()).toBeVisible()
		await expect(
			page.getByRole("link", { name: /payout_1234567890|a1b2c3d4e5f6/ }),
		).toHaveCount(0)
		await expect(page.getByText("Payment funded")).toBeVisible()
		await expect(page.getByText("Simulated").first()).toBeVisible()

		expect(counts.recipients).toBe(1)
		expect(counts.quotes).toBe(1)
		expect(counts.creates).toBe(1)
		expect(counts.funds).toBe(1)
		expect(counts.paymentKey).toBe("payment-quo_1")
		expect(counts.fundKey).toBe("fund-pay_1")
		expect(counts.quoteAuthHeader).toBeUndefined()
		expect(counts.createAuthHeader).toBeUndefined()
	})

	test("a created claim link is handed off to the detail route", async ({
		page,
	}) => {
		await mockApi(page, { createClaimLink: true })
		await page.goto("/")
		await fillQuoteForm(page)
		await page.getByRole("button", { name: "Get quote" }).click()
		await expect(
			page.getByRole("heading", { name: "Chosen route" }),
		).toBeVisible()
		await page.getByRole("radio", { name: "Claim link" }).check()
		await page.getByRole("button", { name: "Create payment" }).click()

		await expect(page).toHaveURL(/\/payments\/pay_1$/)
		const link = page.getByRole("link", { name: "open claim page" })
		await expect(link).toBeVisible()
		await expect(link).toHaveAttribute("href", "/claim/claim_token_1")
	})

	test("an explicit crypto corridor and fee mode are sent without a default", async ({
		page,
	}) => {
		const counts = await mockApi(page)
		await page.goto("/")
		await page.getByLabel("Destination country").selectOption("BR")
		await page
			.getByLabel("Destination", { exact: true })
			.selectOption("crypto_wallet")
		await page.getByLabel("Recipient kind").selectOption("individual")
		await page.getByLabel("Vault fee payer").selectOption("RecipientPays")
		await page.getByLabel("Amount (USD)").fill("25.00")
		await page.getByLabel("Recipient", { exact: true }).fill("Worker B")
		await page.getByRole("button", { name: "Get quote" }).click()

		await expect(
			page.getByRole("heading", { name: "Chosen route" }),
		).toBeVisible()
		expect(counts.quoteBody).toMatchObject({
			feeMode: "RecipientPays",
			destination: {
				type: "crypto_wallet",
				country: "BR",
				currency: "USDC",
			},
		})
	})

	test("a 401 blocks real quote actions and shows the auth blocker", async ({
		page,
	}) => {
		await mockApi(page, {
			quoteError: {
				status: 401,
				body: { code: "unauthorized", message: "Unknown or revoked API key" },
			},
		})
		await page.goto("/")
		await fillQuoteForm(page)
		await page.getByRole("button", { name: "Get quote" }).click()

		await expect(
			page.getByText(/API rejected the server-side key/).first(),
		).toBeVisible()
		await expect(
			page.getByRole("button", { name: "Authentication required" }),
		).toBeDisabled()
	})

	test("an expired quote cannot create a payment", async ({ page }) => {
		await mockApi(page, { quote: quoteFixture(-1_000) })
		await page.goto("/")
		await fillQuoteForm(page)
		await page.getByRole("button", { name: "Get quote" }).click()

		await expect(page.getByText(/This quote has expired/)).toBeVisible()
		await expect(
			page.getByRole("button", { name: "Create payment" }),
		).toBeDisabled()
	})

	test("a 422 quote error shows the returned reasons, not a fixture", async ({
		page,
	}) => {
		await mockApi(page, {
			quoteError: {
				status: 422,
				body: {
					code: "not_eligible",
					message: "No eligible route for this request",
					details: { reasons: ["Crypto is not allowed for this corridor."] },
				},
			},
		})
		await page.goto("/")
		await fillQuoteForm(page)
		await page.getByRole("button", { name: "Get quote" }).click()

		await expect(page.getByText(/Quote request failed/)).toBeVisible()
		// A readable reason passes through unchanged (also listed under technical details).
		await expect(page.getByTestId("quote-error")).toContainText(
			"Crypto is not allowed for this corridor.",
		)
		await expect(
			page.getByRole("button", { name: "Create payment" }),
		).toHaveCount(0)
	})

	test("a double click requests one quote", async ({ page }) => {
		const counts = await mockApi(page, { quoteDelayMs: 400 })
		await page.goto("/")
		await fillQuoteForm(page)
		await page.getByRole("button", { name: "Get quote" }).dblclick()

		await expect(
			page.getByRole("button", { name: "Getting quote…" }),
		).toBeDisabled()
		await expect(
			page.getByRole("heading", { name: "Chosen route" }),
		).toBeVisible()
		expect(counts.quotes).toBe(1)
	})

	test("a double click creates one payment", async ({ page }) => {
		const counts = await mockApi(page, { createDelayMs: 400 })
		await page.goto("/")
		await fillQuoteForm(page)
		await page.getByRole("button", { name: "Get quote" }).click()
		await expect(
			page.getByRole("heading", { name: "Chosen route" }),
		).toBeVisible()

		await page.getByRole("button", { name: "Create payment" }).dblclick()
		await expect(page).toHaveURL(/\/payments\/pay_1$/)
		expect(counts.recipients).toBe(1)
		expect(counts.creates).toBe(1)
	})

	test("a missing release reference is not shown as a link or paid", async ({
		page,
	}) => {
		await mockApi(page)
		await page.goto("/payments/pay_1")

		await expect(
			page.getByText("Awaiting funding", { exact: true }).first(),
		).toBeVisible()
		await expect(page.getByText("Release tx")).toHaveCount(0)
		await expect(page.getByText("Lock tx")).toHaveCount(0)
		await expect(
			page.getByRole("link", { name: /payout_|a1b2|explorer/i }),
		).toHaveCount(0)
		await expect(
			page
				.locator(".panel")
				.filter({ has: page.getByRole("heading", { name: "Payment" }) })
				.getByText("Paid", { exact: true }),
		).toHaveCount(0)
	})

	test("per-leg simulated labels follow the leg field", async ({ page }) => {
		const detail = paymentDetailFixture("processing")
		const settle = detail.legs.find((leg) => leg.kind === "settle")
		if (!settle) throw new Error("settle fixture missing")
		settle.simulated = false
		await mockApi(page, { detail })
		await page.goto("/payments/pay_1")

		await expect(page.getByText("Simulated").first()).toBeVisible()
		const settleItem = page
			.locator(".timeline__item")
			.filter({ hasText: "Settle" })
		await expect(settleItem.getByText("Simulated")).toHaveCount(0)
	})

	test("a failed leg shows its error and retry event", async ({ page }) => {
		await mockApi(page, { detailStatus: "failed" })
		await page.goto("/payments/pay_1")

		await expect(
			page.getByText("Failed", { exact: true }).first(),
		).toBeVisible()
		await expect(page.getByText(/provider_declined/)).toBeVisible()
		await expect(page.getByText("Attempt 2")).toBeVisible()
		await expect(page.getByText("Leg failed", { exact: true })).toBeVisible()
	})

	test("polling stops when the detail page is left", async ({ page }) => {
		const counts = await mockApi(page, { startProcessing: true })
		await page.goto("/payments/pay_1")
		await expect(
			page.getByText("Processing", { exact: true }).first(),
		).toBeVisible()
		await page.waitForTimeout(2_300)
		expect(counts.details).toBeGreaterThanOrEqual(2)

		await page.goto("/")
		await page.waitForTimeout(500)
		const afterNavigation = counts.details
		await page.waitForTimeout(2_300)
		expect(counts.details).toBe(afterNavigation)
	})
})
