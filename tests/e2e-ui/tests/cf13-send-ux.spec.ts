import { expect, test, type Page } from "@playwright/test"
import { friendlyQuoteError } from "../../../packages/web-lib/quote-errors.ts"
import {
	paymentDetailFixture,
	paymentFromDetail,
	quoteFixture,
} from "./fixtures"

// CF13: plain-English quote refusals and a visible, copyable claim link. Fixture coverage only.

const CLAIM_TOKEN = "claim_token_secret_1"

async function mockApi(
	page: Page,
	options: { quoteReasons?: string[]; claimLink?: boolean } = {},
) {
	await page.route(/\/v1\/recipients$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback()
		await route.fulfill({ json: { id: "rcp_1" } })
	})
	await page.route(/\/v1\/quotes$/, async (route) => {
		if (options.quoteReasons) {
			await route.fulfill({
				status: 422,
				json: {
					code: "not_eligible",
					message: "No eligible route",
					details: { reasons: options.quoteReasons },
				},
			})
			return
		}
		await route.fulfill({ json: quoteFixture() })
	})
	await page.route(/\/v1\/payments$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback()
		const created = paymentFromDetail(paymentDetailFixture())
		await route.fulfill({
			json: options.claimLink
				? {
						...created,
						delivery: "claim_link",
						claimLink: {
							url: `http://api.local/v1/claims/${CLAIM_TOKEN}`,
							expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
						},
					}
				: created,
		})
	})
	await page.route(/\/v1\/payments\/pay_1$/, async (route) => {
		await route.fulfill({
			json: {
				...paymentDetailFixture("awaiting_funding"),
				delivery: options.claimLink ? "claim_link" : "direct",
			},
		})
	})
}

async function fillQuoteForm(page: Page) {
	await page.getByLabel("Destination country").selectOption("PH")
	await page.getByLabel("Destination", { exact: true }).selectOption("ewallet")
	await page.getByLabel("Recipient kind").selectOption("individual")
	await page.getByLabel("Vault fee payer").selectOption("PayerPays")
	await page.getByLabel("Amount (USD)").fill("1,250.00")
	await page.getByLabel("Recipient", { exact: true }).fill("Worker A")
}

const REMAINDER_NOTE =
	"PayerPays settle remainder 1 USDC stays unlocked (not a fee; CCR-8/CCR-13)"

test.describe("CF13 quote refusals in plain English", () => {
	test("helper: e-wallet and bank limits become sentences", () => {
		const wallet = friendlyQuoteError([
			"sim_ewallet_ph takes at most 1000000 PHP",
			REMAINDER_NOTE,
		])
		expect(wallet.message).toBe(
			"The Philippines e-wallet accepts payments up to PHP 10,000.00. Your amount is higher. Try a smaller amount or choose another payout method.",
		)
		expect(wallet.message).not.toMatch(/CCR|remainder|unlocked|sim_/)
		expect(wallet.technical).toHaveLength(2)

		const bank = friendlyQuoteError([
			"sim_bank_ph_instapay takes at most 5000000 PHP",
			REMAINDER_NOTE,
		])
		expect(bank.message).toContain("PHP 50,000.00")
		expect(bank.message).toContain("bank transfer (InstaPay)")
	})

	test("helper: minimum, outage, readable reasons and the empty fallback", () => {
		expect(
			friendlyQuoteError(["sim_ewallet_ph takes at least 1000 PHP"]).message,
		).toContain("at least PHP 10.00")
		expect(
			friendlyQuoteError(["Provider sim_ewallet_ph is down"]).message,
		).toContain("temporarily unavailable")
		// A reason that is already readable (country exclusion) passes through unchanged.
		expect(
			friendlyQuoteError(["Company payouts to South Africa are not supported."])
				.message,
		).toBe("Company payouts to South Africa are not supported.")
		// Only internal notes -> generic fallback, never the internal text.
		expect(friendlyQuoteError([REMAINDER_NOTE]).message).toMatch(
			/can't be routed/,
		)
	})

	test("the send page shows the sentence and keeps raw reasons in details", async ({
		page,
	}) => {
		await mockApi(page, {
			quoteReasons: ["sim_ewallet_ph takes at most 1000000 PHP", REMAINDER_NOTE],
		})
		await page.goto("/")
		await fillQuoteForm(page)
		await page.getByRole("button", { name: "Get quote" }).click()

		const notice = page.getByTestId("quote-error")
		await expect(notice).toContainText("Quote request failed:")
		await expect(notice).toContainText("PHP 10,000.00")
		await expect(notice).not.toContainText("CCR")
		await expect(notice).not.toContainText("sim_ewallet_ph")

		const details = page.getByTestId("quote-error-details")
		await expect(details).toContainText("sim_ewallet_ph takes at most 1000000 PHP")
		await expect(page.getByRole("button", { name: "Create payment" })).toHaveCount(0)
	})
})

test.describe("CF13 claim link is visible and copyable", () => {
	const create = async (page: Page) => {
		await page.goto("/")
		await fillQuoteForm(page)
		await page.getByRole("button", { name: "Get quote" }).click()
		await page.getByRole("radio", { name: "Claim link" }).check()
		await page.getByRole("button", { name: "Create payment" }).click()
		await expect(page).toHaveURL(/\/payments\/pay_1$/)
	}

	test("the full URL is shown with a Copy button and a shown-once note", async ({
		page,
		context,
		baseURL,
	}) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"], {
			origin: new URL(baseURL ?? "http://localhost").origin,
		})
		await mockApi(page, { claimLink: true })
		await create(page)

		const field = page.getByTestId("claim-link-url")
		await expect(field).toHaveValue(
			new RegExp(`^https?://[^/]+/claim/${CLAIM_TOKEN}$`),
		)
		await expect(page.getByTestId("claim-link-share")).toContainText(
			"shown once",
		)

		await page.getByRole("button", { name: "Copy link" }).click()
		await expect(page.getByRole("status")).toContainText("Copied")
		const copied = await page.evaluate(() => navigator.clipboard.readText())
		expect(copied).toMatch(new RegExp(`/claim/${CLAIM_TOKEN}$`))
	})

	test("opening the payment elsewhere explains the link cannot be shown again", async ({
		page,
		context,
	}) => {
		await mockApi(page, { claimLink: true })
		await create(page)

		// A fresh tab has no navigation state: the API never re-issues the token.
		const other = await context.newPage()
		await mockApi(other, { claimLink: true })
		await other.goto("/payments/pay_1")
		await expect(other.getByTestId("claim-link-gone")).toContainText(
			"can't be shown again",
		)
		await expect(other.getByTestId("claim-link-url")).toHaveCount(0)

		for (const target of [page, other]) {
			const stored = await target.evaluate(() =>
				JSON.stringify({ ...localStorage }) +
				JSON.stringify({ ...sessionStorage }),
			)
			expect(stored).not.toContain(CLAIM_TOKEN)
		}
	})
})
