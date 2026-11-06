import { expect, test, type Page } from "@playwright/test"

const WALLET = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
const LABEL = "Table 4"
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

const expiredBody = {
	...waitingBody,
	status: "expired",
}

async function mockTillApi(
	page: Page,
	options: { payAfterGets?: number; expireAfterGets?: number } = {},
) {
	const payAfter = options.payAfterGets ?? 2
	const expireAfter = options.expireAfterGets
	let gets = 0
	await page.route(/\/v1\/payment-requests$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback()
		const body = route.request().postDataJSON() as {
			amount?: string
			merchantWallet?: string
			label?: string
		}
		expect(body.amount).toBe("1000")
		expect(body.merchantWallet).toBe(WALLET)
		await route.fulfill({ status: 201, json: waitingBody })
	})
	await page.route(/\/v1\/payment-requests\/pay_till_1$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		gets += 1
		if (expireAfter !== undefined && gets >= expireAfter) {
			await route.fulfill({ json: expiredBody })
			return
		}
		await route.fulfill({
			json: gets >= payAfter ? paidBody : waitingBody,
		})
	})
	return () => gets
}

async function fillAndCreate(page: Page, opts?: { label?: string }) {
	await page.getByLabel("Amount (£)").fill("10.00")
	await page.getByLabel("Merchant wallet").fill(WALLET)
	if (opts?.label !== undefined) {
		await page.getByLabel("Label", { exact: true }).fill(opts.label)
	}
	await page.getByRole("button", { name: "Create QR" }).click()
}

test.describe("Take payment (CCR-27 till QR)", () => {
	test("labels are associated so getByLabel finds the fields", async ({
		page,
	}) => {
		await page.goto("/take-payment")
		await expect(page.getByLabel("Amount (£)")).toBeVisible()
		await expect(page.getByLabel("Merchant wallet")).toBeVisible()
		await expect(page.getByLabel("Label", { exact: true })).toBeVisible()
	})

	test("creates a QR, waits, then flips to paid and stops polling", async ({
		page,
	}) => {
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

		await fillAndCreate(page)

		await expect(page.getByTestId("till-waiting")).toBeVisible()
		await expect(page.getByTestId("till-qr").getByTestId("receive-qr")).toBeVisible()
		await expect(page.getByText("£10.00").first()).toBeVisible()
		await expect(page.getByText("Waiting for payment…").first()).toBeVisible()

		await expect(page.getByTestId("till-paid")).toBeVisible({ timeout: 8_000 })
		await expect(page.getByTestId("till-paid-confirm")).toHaveText(
			"£10.00 received",
		)
		await expect(page.getByTestId("till-explorer")).toHaveAttribute(
			"href",
			paidBody.explorerUrl,
		)
		const getsAtPaid = getGets()
		expect(getsAtPaid).toBeGreaterThanOrEqual(2)

		await page.waitForTimeout(4_500)
		expect(getGets()).toBe(getsAtPaid)

		await page.getByRole("button", { name: "Done" }).click()
		await expect(page.getByTestId("till-paid")).toHaveCount(0)
		await expect(page.getByLabel("Amount (£)")).toHaveValue("")
	})

	test("stops polling after expired", async ({ page }) => {
		const getGets = await mockTillApi(page, {
			payAfterGets: 99,
			expireAfterGets: 2,
		})
		await page.goto("/take-payment")
		await fillAndCreate(page)
		await expect(page.getByTestId("till-expired")).toBeVisible({
			timeout: 8_000,
		})
		const getsAtExpired = getGets()
		expect(getsAtExpired).toBeGreaterThanOrEqual(2)
		await page.waitForTimeout(4_500)
		expect(getGets()).toBe(getsAtExpired)
	})

	test("remembers merchant wallet and label across visits", async ({
		page,
	}) => {
		await mockTillApi(page)
		await page.goto("/take-payment")
		await fillAndCreate(page, { label: LABEL })
		await expect(page.getByTestId("till-waiting")).toBeVisible()

		await page.getByRole("button", { name: "Cancel" }).click()
		await expect(page.getByLabel("Merchant wallet")).toHaveValue(WALLET)
		await expect(page.getByLabel("Label", { exact: true })).toHaveValue(LABEL)
		await expect(page.getByLabel("Amount (£)")).toHaveValue("")
		await expect(page.getByTestId("till-forget-merchant")).toBeVisible()

		await page.reload()
		await expect(page.getByLabel("Merchant wallet")).toHaveValue(WALLET)
		await expect(page.getByLabel("Label", { exact: true })).toHaveValue(LABEL)
		await expect(page.getByLabel("Amount (£)")).toHaveValue("")

		await page.getByTestId("till-forget-merchant").click()
		await expect(page.getByLabel("Merchant wallet")).toHaveValue("")
		await expect(page.getByLabel("Label", { exact: true })).toHaveValue("")
		await expect(page.getByTestId("till-forget-merchant")).toHaveCount(0)
	})

	test("390px: form, QR and paid state do not scroll sideways", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 })
		const getGets = await mockTillApi(page, { payAfterGets: 4 })
		await page.goto("/take-payment")

		const noSideways = async () => {
			const metrics = await page.evaluate(() => ({
				scrollWidth: document.documentElement.scrollWidth,
				innerWidth: window.innerWidth,
			}))
			expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth)
		}

		await noSideways()
		await fillAndCreate(page, { label: LABEL })
		await expect(page.getByTestId("till-waiting")).toBeVisible()
		const qrBox = await page.getByTestId("till-qr").boundingBox()
		expect(qrBox).toBeTruthy()
		expect(qrBox!.width).toBeGreaterThanOrEqual(280)
		await noSideways()

		await page.getByTestId("till-print-toggle").click()
		await expect(page.locator("html.till-print")).toHaveCount(1)
		await expect(page.locator(".app-sidebar")).toBeHidden()
		await expect(page.getByTestId("till-print-toggle")).toBeVisible()
		const amountSize = await page
			.getByTestId("till-waiting-amount")
			.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize))
		expect(amountSize).toBeGreaterThanOrEqual(48)
		await expect(page.getByText("Waiting for payment…").first()).toBeVisible()
		await noSideways()

		await expect(page.getByTestId("till-paid")).toBeVisible({ timeout: 12_000 })
		await expect(page.locator("html.till-print")).toHaveCount(0)
		await noSideways()
		expect(getGets()).toBeGreaterThanOrEqual(4)
	})
})
