import { expect, test } from "@playwright/test"
import { signInLive } from "../helpers/auth"
import {
	LIVE_CREDENTIALS_SKIP_MESSAGE,
	liveCredentials,
} from "../helpers/credentials"

// Live checks for the aggregator screens (CCR-28/29, PR #150). Read-only: no payment is created.

const { ready } = liveCredentials()

test.describe("Live aggregator (read-only)", () => {
	test.beforeEach(() => {
		test.skip(!ready, LIVE_CREDENTIALS_SKIP_MESSAGE)
	})

	test("Where we pay lists coverage on paper", async ({ page }) => {
		await signInLive(page)
		await page.goto("/where-we-pay")
		await expect(
			page.getByRole("heading", { name: /Where we pay/i }),
		).toBeVisible({
			timeout: 90_000,
		})
		await expect(page.getByText(/not live payments/i).first()).toBeVisible()
		await expect(page.getByText("Brazil").first()).toBeVisible()
	})

	test("US to Brazil bank quote compares partners and shows BlindPay as Sandbox", async ({
		page,
	}) => {
		await signInLive(page)
		await page.goto("/")
		await expect(
			page.getByRole("heading", { name: "Send a payment" }),
		).toBeVisible({
			timeout: 90_000,
		})
		const country = page.getByLabel("Destination country")
		await expect(country.locator('option[value="BR"]')).toHaveCount(1, {
			timeout: 90_000,
		})
		await country.selectOption("BR")
		// TASK 20: Brazil is reachable from GBP (Tazapay) and USD (BlindPay); BlindPay needs USD.
		const sendFrom = page.getByLabel("Send from")
		await expect(sendFrom).toHaveValue("GB:GBP")
		await sendFrom.selectOption("US:USD")
		await page
			.getByLabel("Destination", { exact: true })
			.selectOption("bank_account")
		await page.getByLabel("Recipient kind").selectOption("individual")
		const feePayer = page.getByLabel("Vault fee payer")
		if (await feePayer.count()) await feePayer.selectOption("RecipientPays")
		await page.getByLabel(/^Amount/).fill("100.00")
		await page
			.getByLabel("Recipient", { exact: true })
			.fill("Live QA Brazil quote")
		await page.getByRole("button", { name: "Get quote" }).click()

		const why = page.getByTestId("why-this-route")
		await expect(why).toBeVisible({ timeout: 120_000 })
		await expect(why.getByText(/Blindpay/i).first()).toBeVisible()
		await expect(
			why.getByTestId("provider-badge").filter({ hasText: "Sandbox" }).first(),
		).toBeVisible()
		await expect(why.getByText(/Best payout route/i).first()).toBeVisible()
		await expect(
			page.getByRole("heading", { name: "Other eligible routes" }),
		).toBeVisible()
		// Task 26 + CCR-38: the losing payout option is a real alternative, so the saving shows.
		await expect(page.getByTestId("aggregator-saving")).toContainText(
			/more than the next best route/,
		)
		await expect(
			page.getByRole("button", { name: "Create payment" }),
		).toBeVisible()
	})

	test("UK to Kenya bank quote prices pounds through Tazapay (CCR-31)", async ({
		page,
	}) => {
		await signInLive(page)
		await page.goto("/")
		await expect(
			page.getByRole("heading", { name: "Send a payment" }),
		).toBeVisible({
			timeout: 90_000,
		})
		const country = page.getByLabel("Destination country")
		await expect(country.locator('option[value="KE"]')).toHaveText("Kenya", {
			timeout: 90_000,
		})
		await country.selectOption("KE")
		await expect(page.getByText("GBP bank account").first()).toBeVisible()
		await page
			.getByLabel("Destination", { exact: true })
			.selectOption("bank_account")
		await page.getByLabel("Recipient kind").selectOption("individual")
		const feePayer = page.getByLabel("Vault fee payer")
		if (await feePayer.count()) await feePayer.selectOption("RecipientPays")
		await page.getByLabel(/^Amount/).fill("100.00")
		await page
			.getByLabel("Recipient", { exact: true })
			.fill("Live QA Kenya quote")
		await page.getByRole("button", { name: "Get quote" }).click()

		const why = page.getByTestId("why-this-route")
		await expect(why).toBeVisible({ timeout: 120_000 })
		await expect(why.getByText(/Tazapay/i).first()).toBeVisible()
		await expect(
			why.getByTestId("provider-badge").filter({ hasText: "Sandbox" }).first(),
		).toBeVisible()
		await expect(page.getByText(/KES/).first()).toBeVisible()
		await expect(
			page.getByRole("button", { name: "Create payment" }),
		).toBeVisible()
	})
})
