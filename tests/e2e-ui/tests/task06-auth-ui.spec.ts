import { test, expect, type Page } from "@playwright/test"

// TASK 06 browser tests for the auth screens. The HTTP layer is MOCKED by Playwright (this is
// UI behaviour coverage, not an integration test): the real Express + Better Auth + Prisma
// behaviour is covered by apps/api/test/auth.test.ts against a real database.

const ME = {
	via: "session",
	organization: { id: "org_1", name: "Ana" },
	user: { id: "u1", email: "ana@example.com", name: "Ana" },
}

async function mockSignedOut(page: Page) {
	await page.route(/\/v1\/me$/, (route) =>
		route.fulfill({
			status: 401,
			json: { code: "unauthorized", message: "Not signed in" },
		}),
	)
}

test.describe("TASK 06 auth screens (mocked HTTP)", () => {
	test("a signed-out visitor is sent to the sign-in page", async ({ page }) => {
		await mockSignedOut(page)
		await page.goto("/")
		await expect(page).toHaveURL(/\/login$/)
		await expect(
			page.getByRole("heading", { name: "Sign in to FlexiPay" }),
		).toBeVisible()
	})

	test("sign-in sends only email and password, then shows the app and the user", async ({
		page,
	}) => {
		let signedIn = false
		await page.route(/\/v1\/me$/, (route) =>
			signedIn
				? route.fulfill({ json: ME })
				: route.fulfill({ status: 401, json: { code: "unauthorized" } }),
		)
		let body: unknown = null
		await page.route(/\/api\/auth\/sign-in\/email$/, async (route) => {
			body = route.request().postDataJSON()
			signedIn = true
			await route.fulfill({ json: { redirect: false } })
		})
		await page.route(/\/v1\/(corridors|payments)(\?.*)?$/, (route) =>
			route.fulfill({ json: { corridors: [], payments: [], nextCursor: null } }),
		)
		await page.goto("/login")
		await page.getByLabel("Email").fill("ana@example.com")
		await page.getByLabel("Password").fill("correct-horse-1")
		await page.getByRole("button", { name: "Sign in" }).click()
		await expect(page.getByTestId("session-box")).toContainText(
			"ana@example.com",
		)
		expect(body).toEqual({
			email: "ana@example.com",
			password: "correct-horse-1",
		})
	})

	test("an unverified account is told to confirm its email and can resend", async ({
		page,
	}) => {
		await mockSignedOut(page)
		await page.route(/\/api\/auth\/sign-in\/email$/, (route) =>
			route.fulfill({
				status: 403,
				json: { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" },
			}),
		)
		let resent = 0
		await page.route(/\/api\/auth\/send-verification-email$/, (route) => {
			resent += 1
			return route.fulfill({ json: { status: true } })
		})
		await page.goto("/login")
		await page.getByLabel("Email").fill("ana@example.com")
		await page.getByLabel("Password").fill("correct-horse-1")
		await page.getByRole("button", { name: "Sign in" }).click()
		await expect(page.getByText("Confirm your email first.")).toBeVisible()
		await page.getByRole("button", { name: "Resend the email" }).click()
		await expect(page.getByRole("button", { name: "Sent" })).toBeVisible()
		expect(resent).toBe(1)
	})

	test("rate limiting is explained, not shown as a crash", async ({ page }) => {
		await mockSignedOut(page)
		await page.route(/\/api\/auth\/sign-in\/email$/, (route) =>
			route.fulfill({
				status: 429,
				json: { code: "rate_limited", message: "x" },
			}),
		)
		await page.goto("/login")
		await page.getByLabel("Email").fill("a@example.com")
		await page.getByLabel("Password").fill("whatever-123")
		await page.getByRole("button", { name: "Sign in" }).click()
		await expect(page.getByRole("alert")).toContainText("Too many attempts")
	})

	test("registration asks the user to check their email", async ({ page }) => {
		await mockSignedOut(page)
		await page.route(/\/api\/auth\/sign-up\/email$/, (route) =>
			route.fulfill({ json: { token: null, user: { id: "u1" } } }),
		)
		await page.goto("/register")
		await page.getByLabel("Name").fill("Ana")
		await page.getByLabel("Email").fill("ana@example.com")
		await page.getByLabel("Password").fill("correct-horse-1")
		await page.getByRole("button", { name: "Create account" }).click()
		await expect(
			page.getByRole("heading", { name: "Check your email" }),
		).toBeVisible()
	})

	test("the reset page rejects a missing token and posts the token it was given", async ({
		page,
	}) => {
		await page.goto("/reset-password")
		await expect(
			page.getByRole("heading", { name: "Reset link not valid" }),
		).toBeVisible()

		let body: unknown = null
		await page.route(/\/api\/auth\/reset-password$/, async (route) => {
			body = route.request().postDataJSON()
			await route.fulfill({ json: { status: true } })
		})
		await page.goto("/reset-password?token=tok_123")
		await page.getByLabel("New password").fill("brand-new-pass-9")
		await page.getByRole("button", { name: "Change password" }).click()
		await expect(
			page.getByRole("heading", { name: "Password changed" }),
		).toBeVisible()
		expect(body).toEqual({ token: "tok_123", newPassword: "brand-new-pass-9" })
	})

	test("sign out calls the API and returns to the sign-in page", async ({
		page,
	}) => {
		let out = false
		await page.route(/\/v1\/me$/, (route) =>
			out
				? route.fulfill({ status: 401, json: { code: "unauthorized" } })
				: route.fulfill({ json: ME }),
		)
		await page.route(/\/api\/auth\/sign-out$/, (route) => {
			out = true
			return route.fulfill({ json: { success: true } })
		})
		await page.route(/\/v1\/(corridors|payments)(\?.*)?$/, (route) =>
			route.fulfill({ json: { corridors: [], payments: [], nextCursor: null } }),
		)
		await page.goto("/")
		await page.getByRole("button", { name: "Sign out" }).click()
		await expect(page).toHaveURL(/\/login$/)
	})
})
