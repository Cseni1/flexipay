import { expect, test } from "@playwright/test"
import { signInLive } from "../helpers/auth"
import {
	LIVE_CREDENTIALS_SKIP_MESSAGE,
	liveCredentials,
} from "../helpers/credentials"

/**
 * Real sandbox end-to-end: USD → PH bank via Tazapay.
 * Creates one payment per run. Skip when FP_QA_EMAIL / FP_QA_PASSWORD are unset.
 *
 * Run alone: npm run test:live:payout
 */

const { ready } = liveCredentials()

const TEN_MINUTES_MS = 10 * 60_000
const SIX_MINUTES_MS = 6 * 60_000

function randomAccountNumber(): string {
	const suffix = String(Math.floor(Math.random() * 100_000_000)).padStart(
		8,
		"0",
	)
	return `0098${suffix}`
}

test.describe("Live payout (Tazapay PH bank)", () => {
	test.describe.configure({ timeout: TEN_MINUTES_MS })

	test.beforeEach(() => {
		test.skip(!ready, LIVE_CREDENTIALS_SKIP_MESSAGE)
	})

	test("Send → Fund → Waiting for Tazapay → Paid (sandbox)", async ({
		page,
	}) => {
		test.setTimeout(TEN_MINUTES_MS)

		const stamp = Date.now()
		// Tazapay refuses beneficiary names with digits (CCR-36), so the unique part is letters only.
		const letters = stamp
			.toString(26)
			.replace(/[0-9]/g, (d) => "abcdefghij"[Number(d)]!)
		const recipientName = `Live QA Maria ${letters}`
		const accountNumber = randomAccountNumber()
		const accountLast4 = accountNumber.slice(-4)

		await signInLive(page)
		await page.goto("/")
		await expect(
			page.getByRole("heading", { name: "Send a payment" }),
		).toBeVisible({ timeout: 90_000 })

		const country = page.getByLabel("Destination country")
		await expect(country.locator('option[value="PH"]')).toHaveCount(1, {
			timeout: 90_000,
		})
		await country.selectOption("PH")

		const sendFrom = page.getByLabel("Send from")
		await expect(sendFrom).toBeVisible({ timeout: 90_000 })
		await sendFrom.selectOption({ label: "USD operating account (US)" })
		await expect(page.getByLabel("Amount (USD)")).toBeVisible()

		await page
			.getByLabel("Destination", { exact: true })
			.selectOption("bank_account")
		await page.getByLabel("Recipient kind").selectOption("individual")
		await page.getByLabel("Vault fee payer").selectOption("PayerPays")
		await page.getByLabel("Amount (USD)").fill("200.00")
		await page.getByLabel("Recipient", { exact: true }).fill(recipientName)

		const bank = page.getByTestId("bank-details")
		await expect(bank).toBeVisible()
		await bank.getByLabel(/Account number/).fill(accountNumber)
		await bank.getByLabel("Account holder name").fill(recipientName)
		await bank.getByLabel("Bank name").fill("Banco De Oro Unibank, Inc.")
		await bank.getByLabel("SWIFT/BIC").fill("BNORPHMM")

		await page.getByRole("button", { name: "Get quote" }).click()

		const why = page.getByTestId("why-this-route")
		await expect(why).toBeVisible({ timeout: 120_000 })
		await expect(why.getByText(/Tazapay/i).first()).toBeVisible()
		await expect(
			why.getByTestId("provider-badge").filter({ hasText: "Sandbox" }).first(),
		).toBeVisible()

		await page.getByRole("button", { name: "Create payment" }).click()
		await expect(page).toHaveURL(/\/payments\/pay_/, { timeout: 90_000 })
		await expect(
			page.getByRole("heading", { name: "Payment detail" }),
		).toBeVisible({ timeout: 90_000 })

		await page.getByRole("button", { name: "Fund payment" }).click()

		await expect(page.getByText(/Waiting for Tazapay/i).first()).toBeVisible({
			timeout: 120_000,
		})
		// The paid-at timestamp appears only after payment.paid (a bare "Paid" text matches other
		// labels on the page and passed while the payout was still processing).
		await expect(page.getByTestId("payment-paid-at")).toBeVisible({
			timeout: SIX_MINUTES_MS,
		})

		const destination = page.getByTestId("payment-to-destination")
		await expect(destination).toContainText(accountLast4, { timeout: 90_000 })
		await expect(destination).toContainText(/•{2,}/)
		await expect(page.locator("main")).not.toContainText(accountNumber)

		await page.goto("/recipients")
		await expect(
			page.getByRole("heading", { name: "Recipients", exact: true }),
		).toBeVisible({ timeout: 90_000 })
		await page.getByRole("button", { name: recipientName, exact: true }).click()
		const endpoints = page.getByTestId("endpoints-table")
		await expect(endpoints).toBeVisible({ timeout: 90_000 })
		await expect(endpoints).toContainText(accountLast4)
		await expect(endpoints).toContainText(/•{2,}/)
		await expect(endpoints).not.toContainText(accountNumber)
		const body = await page.locator("main").innerText()
		expect(body).not.toContain(accountNumber)
	})
})
