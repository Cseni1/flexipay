import { expect, test, type Page } from "@playwright/test"
import { paymentDetailFixture, paymentFromDetail } from "./fixtures"

const now = (offsetMs = 0): string =>
	new Date(Date.now() + offsetMs).toISOString()

const tgbpClaim = {
	paymentId: "pay_tgbp_1",
	status: "open",
	paymentStatus: "processing",
	expiresAt: now(120_000),
	amount: { amount: "99009900", currency: "TGBP" },
	corridor: {
		from: { country: "GB", currency: "GBP" },
		to: { country: "GB", currency: "GBP" },
	},
	allowedDestinationTypes: ["crypto_wallet"],
	simulated: true,
}

const gbpPaymentDetail = () => {
	const base = paymentDetailFixture("awaiting_funding")
	const legs = base.legs.map((leg, index) =>
		index === 0
			? {
					...leg,
					amountIn: { amount: "1000", currency: "GBP" },
					amountOut: { amount: "1000", currency: "GBP" },
				}
			: {
					...leg,
					amountIn: { amount: "99009900", currency: "TGBP" },
					amountOut: { amount: "99009900", currency: "TGBP" },
					rail: leg.kind === "settle" ? "solana_tgbp" : leg.rail,
					providerId: leg.kind === "settle" ? "solana_tgbp" : leg.providerId,
				},
	)
	return { ...base, id: "pay_gbp_1", legs }
}

async function mockTgbpClaim(page: Page) {
	await page.route(/\/v1\/claims\/claim_token_tgbp$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ json: tgbpClaim })
	})
}

async function mockGbpPayment(page: Page) {
	const detail = gbpPaymentDetail()
	await page.route(/\/v1\/payments\/pay_gbp_1$/, async (route) => {
		await route.fulfill({ json: detail })
	})
	await page.route(/\/v1\/payments$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		// List schema is strict: payments only (no nextCursor).
		await route.fulfill({
			json: { payments: [paymentFromDetail(detail)] },
		})
	})
}

test.describe("GBP/TGBP money display", () => {
	test("claim page shows £9.90 and asset-neutral Solana intro", async ({
		page,
	}) => {
		await mockTgbpClaim(page)
		await page.goto("/claim/claim_token_tgbp")
		await expect(page.getByTestId("claim-amount")).toHaveText("£9.90")
		await expect(page.getByText("99,009,900")).toHaveCount(0)
		await expect(page.getByText(/TGBP/)).toHaveCount(0)
		await expect(
			page.getByText(/Solana devnet only; no real money moves/),
		).toBeVisible()
		await expect(page.getByText(/Solana USDC is devnet only/)).toHaveCount(0)
	})

	test("payment detail and history show £10.00 for GBP source amount", async ({
		page,
	}) => {
		await mockGbpPayment(page)
		await page.goto("/payments/pay_gbp_1")
		await expect(page.getByText("£10.00").first()).toBeVisible()
		await expect(page.getByText("1,000 GBP")).toHaveCount(0)
		await expect(page.getByText("£9.90").first()).toBeVisible()

		await page.goto("/payments")
		await expect(page.getByTestId("payment-history")).toContainText("£10.00")
		await expect(page.getByTestId("payment-history")).not.toContainText(
			"1,000 GBP",
		)

		await page.goto("/dashboard")
		await expect(page.getByTestId("payment-history")).toContainText("£10.00")
	})
})
