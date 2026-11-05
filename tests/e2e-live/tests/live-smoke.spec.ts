import { expect, test } from "@playwright/test"
import { signInLive } from "../helpers/auth"
import {
	LIVE_CREDENTIALS_SKIP_MESSAGE,
	liveCredentials,
} from "../helpers/credentials"

const { ready } = liveCredentials()

test.describe("Live smoke (read-mostly)", () => {
	test.beforeEach(() => {
		test.skip(!ready, LIVE_CREDENTIALS_SKIP_MESSAGE)
	})

	test("sign in and open the dashboard", async ({ page }) => {
		await signInLive(page)
		await page.getByRole("navigation", { name: "Primary" }).getByRole("link", {
			name: "Dashboard",
		}).click()
		await expect(page).toHaveURL(/\/dashboard\/?$/)
		await expect(
			page.getByRole("heading", { name: "Dashboard" }),
		).toBeVisible({ timeout: 90_000 })
		await expect(page.getByTestId("dashboard-stats")).toBeVisible()
	})

	test("Pay from shows Add funds and the FlexiPay wallet card", async ({
		page,
	}) => {
		await signInLive(page)
		await page.goto("/pay-from")
		await expect(
			page.getByRole("heading", { name: "Pay from" }),
		).toBeVisible({ timeout: 90_000 })
		await expect(page.getByTestId("add-funds-panel")).toBeVisible({
			timeout: 90_000,
		})
		await expect(page.getByTestId("flexipay-wallet-card")).toBeVisible({
			timeout: 90_000,
		})
	})

	test("UK send form quotes £9.90 receive and £0.10 fees for £10", async ({
		page,
	}) => {
		await signInLive(page)
		await page.goto("/")
		await expect(
			page.getByRole("heading", { name: "Send a payment" }),
		).toBeVisible({ timeout: 90_000 })

		const country = page.getByLabel("Destination country")
		await expect(country).toBeVisible({ timeout: 90_000 })
		await expect(country.locator('option[value="GB"]')).toHaveCount(1, {
			timeout: 90_000,
		})
		await country.selectOption("GB")

		await expect(page.getByText("GBP bank account", { exact: true })).toBeVisible()
		const destination = page.getByLabel("Destination", { exact: true })
		await expect(destination).toHaveValue("crypto_wallet")
		const destinationLabel = await destination.evaluate(
			(el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? "",
		)
		expect(destinationLabel).toMatch(/Crypto wallet \(tGBP/)

		await page.getByLabel("Recipient kind").selectOption("individual")
		await page.getByLabel("Vault fee payer").selectOption("PayerPays")
		await page.getByLabel("Amount (£)").fill("10.00")
		await page.getByLabel("Recipient", { exact: true }).fill("Live QA quote")
		await page.getByRole("button", { name: "Get quote" }).click()

		await expect(page.getByText("Expected receive")).toBeVisible({
			timeout: 90_000,
		})
		await expect(page.getByText("£9.90").first()).toBeVisible({
			timeout: 90_000,
		})
		await expect(page.getByText("All fees")).toBeVisible()
		await expect(page.getByText("£0.10").first()).toBeVisible()
		// Read-only: do not create a payment.
		await expect(
			page.getByRole("button", { name: "Create payment" }),
		).toBeVisible()
	})

	test("Payments list and Account load without raw TGBP minors", async ({
		page,
	}) => {
		await signInLive(page)

		await page.goto("/payments")
		await expect(
			page.getByRole("heading", { name: "Payments", exact: true }),
		).toBeVisible({ timeout: 90_000 })
		const paymentsBody = await page.locator("main").innerText()
		expect(paymentsBody).not.toMatch(/\bTGBP\b/)
		expect(paymentsBody).not.toMatch(/99,?009,?900/)

		await page.goto("/account")
		await expect(
			page.getByRole("heading", { name: /Account/i }),
		).toBeVisible({ timeout: 90_000 })
		const accountBody = await page.locator("main").innerText()
		expect(accountBody).not.toMatch(/\bTGBP\b/)
		expect(accountBody).not.toMatch(/99,?009,?900/)
	})

	test("Take payment page loads when the route exists", async ({ page }) => {
		await signInLive(page)
		await page.goto("/take-payment")
		// SPA always serves index; detect the till form vs fall-through to home.
		const takeHeading = page.getByRole("heading", { name: "Take payment" })
		const sendHeading = page.getByRole("heading", { name: "Send a payment" })
		await Promise.race([
			takeHeading.waitFor({ state: "visible", timeout: 90_000 }).catch(() => null),
			sendHeading.waitFor({ state: "visible", timeout: 90_000 }).catch(() => null),
		])
		if (!(await takeHeading.isVisible().catch(() => false))) {
			test.info().annotations.push({
				type: "note",
				description: "/take-payment not deployed yet; form assertions skipped.",
			})
			return
		}
		await expect(page.getByLabel("Amount (£)")).toBeVisible()
		await expect(page.getByRole("button", { name: "Create QR" })).toBeVisible()
	})
})

