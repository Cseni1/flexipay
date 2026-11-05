import { expect, test, type Page } from "@playwright/test"

const WALLET = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
const SOLANA_PAY_URL = `solana:${WALLET}?amount=10&spl-token=TgbpMint111&reference=ref_till_1&label=Till`

const waitingBody = {
	id: "pay_till_1",
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
	signature: "5SigTillDemoaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	explorerUrl: "https://explorer.solana.com/tx/5SigTillDemo?cluster=devnet",
}

async function mockTillApi(page: Page) {
	let gets = 0
	await page.route(/\/v1\/payment-requests$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback()
		const body = route.request().postDataJSON() as {
			amount?: string
			merchantWallet?: string
		}
		expect(body.amount).toBe("1000")
		expect(body.merchantWallet).toBe(WALLET)
		await route.fulfill({ status: 201, json: waitingBody })
	})
	await page.route(/\/v1\/payment-requests\/pay_till_1$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		gets += 1
		await route.fulfill({
			json: gets >= 2 ? paidBody : waitingBody,
		})
	})
	return () => gets
}

test.describe("Take payment (CCR-27 till QR)", () => {
	test("creates a QR, waits, then flips to paid", async ({ page }) => {
		const getGets = await mockTillApi(page)
		await page.goto("/take-payment")

		await expect(page.getByRole("heading", { name: "Take payment" })).toBeVisible()
		await expect(page.getByTestId("till-devnet-note")).toContainText(
			"devnet tGBP",
		)
		await expect(
			page.getByRole("navigation", { name: "Primary" }).getByRole("link", {
				name: "Take payment",
			}),
		).toBeVisible()

		await page.getByLabel("Amount (£)").fill("10.00")
		await page.getByLabel("Merchant wallet").fill(WALLET)
		await page.getByRole("button", { name: "Create QR" }).click()

		await expect(page.getByTestId("till-waiting")).toBeVisible()
		await expect(page.getByTestId("till-qr").getByTestId("receive-qr")).toBeVisible()
		await expect(page.getByText("£10.00").first()).toBeVisible()
		await expect(page.getByText("Waiting for payment…").first()).toBeVisible()

		await expect(page.getByTestId("till-paid")).toBeVisible({ timeout: 8_000 })
		await expect(page.getByTestId("till-paid")).toContainText("Paid £10.00")
		await expect(page.getByTestId("till-explorer")).toHaveAttribute(
			"href",
			paidBody.explorerUrl,
		)
		expect(getGets()).toBeGreaterThanOrEqual(2)
	})
})
