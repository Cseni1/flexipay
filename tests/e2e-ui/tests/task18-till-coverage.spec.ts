import { expect, test, type Page } from "@playwright/test"

const WALLET = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
const PAYER = "PayEr111111111111111111111111111111111111"
const SOLANA_PAY_URL = `solana:${WALLET}?amount=10&spl-token=TgbpMint111&reference=ref_till_1&label=Till`

const waitingBody = {
	id: "pay_till_18",
	status: "waiting",
	amount: { amount: "100000000", currency: "TGBP" },
	merchantWallet: WALLET,
	reference: "ref_till_1",
	solanaPayUrl: SOLANA_PAY_URL,
	expiresAt: new Date(Date.now() + 900_000).toISOString(),
}

const paidBody = {
	...waitingBody,
	status: "paid",
	signature: "5SigTillTask18aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	explorerUrl: "https://explorer.solana.com/tx/5SigTillTask18?cluster=devnet",
	payer: PAYER,
}

async function mockTill(page: Page) {
	let gets = 0
	await page.route(/\/v1\/payment-requests$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback()
		await route.fulfill({ status: 201, json: waitingBody })
	})
	await page.route(/\/v1\/payment-requests\/pay_till_18$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		gets += 1
		await route.fulfill({
			json: gets >= 2 ? paidBody : waitingBody,
		})
	})
}

test.describe("TASK 18 till paid screen and coverage", () => {
	test("paid request shows full-screen £ received until Done", async ({
		page,
	}) => {
		await mockTill(page)
		await page.goto("/take-payment")
		await page.getByLabel("Amount (£)").fill("10.00")
		await page.getByLabel("Merchant wallet").fill(WALLET)
		await page.getByRole("button", { name: "Create QR" }).click()
		await expect(page.getByTestId("till-waiting")).toBeVisible()
		await expect(page.getByTestId("till-paid")).toBeVisible({ timeout: 8_000 })
		await expect(page.getByTestId("till-paid-confirm")).toHaveText(
			"£10.00 received",
		)
		await expect(page.getByTestId("till-paid-payer")).toContainText("PayE…1111")
		await expect(page.getByTestId("till-paid-done")).toBeVisible()
		await page.getByTestId("till-paid-done").click()
		await expect(page.getByTestId("till-paid")).toHaveCount(0)
		await expect(page.getByLabel("Amount (£)")).toBeVisible()
	})

	test("390px paid confirm and Where we pay stay in width", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 })
		const noSideways = async () => {
			const metrics = await page.evaluate(() => ({
				scrollWidth: document.documentElement.scrollWidth,
				innerWidth: window.innerWidth,
			}))
			expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth)
		}

		await mockTill(page)
		await page.goto("/take-payment")
		await page.getByLabel("Amount (£)").fill("10.00")
		await page.getByLabel("Merchant wallet").fill(WALLET)
		await page.getByRole("button", { name: "Create QR" }).click()
		await expect(page.getByTestId("till-paid")).toBeVisible({ timeout: 8_000 })
		await noSideways()
		await page.getByTestId("till-paid-done").click()

		await page.goto("/where-we-pay")
		await expect(
			page.getByRole("heading", { name: "Where we pay" }),
		).toBeVisible()
		await expect(page.getByTestId("coverage-disclaimer")).toContainText(
			"coverage on paper, not live payments",
		)
		await expect(page.getByTestId("coverage-disclaimer")).toContainText(
			"6 Nov 2026",
		)
		await expect(page.getByText("United Kingdom")).toBeVisible()
		await expect(page.getByText("Local bank rail").first()).toBeVisible()
		await noSideways()
	})

	test("nav reaches Where we pay", async ({ page }) => {
		await page.goto("/dashboard")
		await page
			.getByRole("navigation", { name: "Primary" })
			.getByRole("link", { name: "Where we pay" })
			.click()
		await expect(page).toHaveURL(/\/where-we-pay$/)
		await expect(
			page.getByRole("heading", { name: "Where we pay" }),
		).toBeVisible()
	})
})
