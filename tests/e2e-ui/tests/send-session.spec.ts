import { test, expect, type Page } from "@playwright/test"

// Send flow with a signed-in customer session. The HTTP layer is MOCKED by Playwright, so this
// covers browser behaviour only: no Authorization header from the browser, and what the user
// sees when the session ends. Real API + real session behaviour is covered by
// apps/api/test/*customer-auth*.test.ts and the recorded local browser run in the PR.

const SESSION_ME = {
	via: "session",
	organization: { id: "org_1", name: "Ana" },
	user: { id: "u1", email: "ana@example.com", name: "Ana" },
}

async function fillQuoteForm(page: Page) {
	await page.getByLabel("Destination country").selectOption("PH")
	await page.getByLabel("Destination", { exact: true }).selectOption("ewallet")
	await page.getByLabel("Recipient kind").selectOption("individual")
	await page.getByLabel("Who pays the fee?").selectOption("PayerPays")
	await page.getByLabel("Amount (USD)").fill("1,250.00")
	await page.getByLabel("Recipient", { exact: true }).fill("Worker A")
}

async function mockSignedIn(
	page: Page,
	opts: { meAfterQuote401?: "still_session" | "signed_out" },
) {
	let quoted = false
	const seen = { authHeaders: [] as (string | undefined)[], cookies: 0 }
	await page.route(/\/v1\/me$/, (route) => {
		if (quoted && opts.meAfterQuote401 === "signed_out")
			return route.fulfill({
				status: 401,
				json: { code: "unauthorized", message: "Not signed in" },
			})
		return route.fulfill({ json: SESSION_ME })
	})
	await page.route(/\/v1\/recipients$/, async (route) => {
		seen.authHeaders.push(route.request().headers()["authorization"])
		if (route.request().method() === "POST")
			return route.fulfill({ status: 201, json: { id: "rcp_1" } })
		return route.fulfill({ json: { recipients: [] } })
	})
	await page.route(/\/v1\/quotes$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback()
		seen.authHeaders.push(route.request().headers()["authorization"])
		quoted = true
		await route.fulfill({
			status: 401,
			json: { code: "unauthorized", message: "Not signed in" },
		})
	})
	return seen
}

test.describe("Send with a signed-in customer session (mocked HTTP)", () => {
	test("the browser sends no Authorization header; a 401 for a session says sign in again", async ({
		page,
	}) => {
		const seen = await mockSignedIn(page, { meAfterQuote401: "still_session" })
		await page.goto("/")
		await expect(page.getByTestId("session-box")).toContainText(
			"ana@example.com",
		)
		await fillQuoteForm(page)
		await page.getByRole("button", { name: "Get quote" }).click()

		// Session-aware wording, not the dev-proxy FP_API_KEY instructions.
		await expect(page.getByTestId("session-ended")).toBeVisible()
		await expect(page.getByText(/could not authenticate/)).toHaveCount(0)
		await expect(page.getByText(/rejected the server-side key/)).toHaveCount(0)
		await expect(page.getByText(/Your sign-in has ended/).first()).toBeVisible()
		await expect(
			page.getByRole("button", { name: "Authentication required" }),
		).toBeDisabled()
		expect(seen.authHeaders.length).toBeGreaterThan(0)
		expect(seen.authHeaders.every((h) => h === undefined)).toBe(true)
	})

	test("when the session has really ended, a 401 sends the customer to /login", async ({
		page,
	}) => {
		await mockSignedIn(page, { meAfterQuote401: "signed_out" })
		await page.goto("/")
		await expect(page.getByTestId("session-box")).toBeVisible()
		await fillQuoteForm(page)
		await page.getByRole("button", { name: "Get quote" }).click()
		await expect(page).toHaveURL(/\/login$/)
		await expect(
			page.getByRole("heading", { name: "Sign in to FlexiPay" }),
		).toBeVisible()
	})

	test("in dev-proxy key mode a 401 keeps the existing server-key explanation and no redirect", async ({
		page,
	}) => {
		await page.route(/\/v1\/me$/, (route) =>
			route.fulfill({
				json: {
					via: "api_key",
					organization: { id: "org_1", name: "Demo" },
					user: null,
				},
			}),
		)
		await page.route(/\/v1\/quotes$/, (route) => {
			if (route.request().method() !== "POST") return route.fallback()
			return route.fulfill({
				status: 401,
				json: { code: "unauthorized", message: "Unknown or revoked API key" },
			})
		})
		await page.goto("/")
		await fillQuoteForm(page)
		await page.getByRole("button", { name: "Get quote" }).click()
		await expect(
			page.getByText(/API rejected the server-side key/).first(),
		).toBeVisible()
		await expect(page).not.toHaveURL(/\/login/)
	})
})
