import { expect, test, type Page } from "@playwright/test"

const ME = {
	via: "session",
	organization: { id: "org_1", name: "Ana" },
	user: { id: "u1", email: "ana@example.com", name: "Ana" },
}

const activeKey = {
	id: "key_active",
	prefix: "fp_test_abcd",
	label: "CI runner",
	createdAt: "2026-11-01T12:00:00.000Z",
	revokedAt: null,
}

async function mockSessionShell(page: Page) {
	await page.route(/\/v1\/me$/, (route) => route.fulfill({ json: ME }))
	await page.route(/\/v1\/(corridors|payments|health)(\?.*)?$/, (route) =>
		route.fulfill({
			json: { corridors: [], payments: [], nextCursor: null, status: "ok" },
		}),
	)
	await page.route(/\/healthz$/, (route) =>
		route.fulfill({ json: { status: "ok" } }),
	)
}

test.describe("Account: API keys and change password", () => {
	test("lists keys, creates once with copy warning, and revokes with confirm", async ({
		page,
		context,
		baseURL,
	}) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"], {
			origin: new URL(baseURL ?? "http://localhost").origin,
		})
		await mockSessionShell(page)
		let keys = [activeKey]
		await page.route(/\/v1\/api-keys$/, async (route) => {
			if (route.request().method() === "GET") {
				await route.fulfill({ json: { keys } })
				return
			}
			if (route.request().method() === "POST") {
				const body = route.request().postDataJSON() as { label?: string }
				const created = {
					id: "key_new",
					prefix: "fp_test_new1",
					label: body.label ?? null,
					createdAt: "2026-11-04T10:00:00.000Z",
					revokedAt: null,
					key: "fp_test_new1_secret_shown_once_only",
				}
				keys = [
					...keys,
					{
						id: created.id,
						prefix: created.prefix,
						label: created.label,
						createdAt: created.createdAt,
						revokedAt: created.revokedAt,
					},
				]
				await route.fulfill({ status: 201, json: created })
				return
			}
			await route.fallback()
		})
		await page.route(/\/v1\/api-keys\/key_active\/revoke$/, async (route) => {
			keys = keys.map((row) =>
				row.id === "key_active"
					? { ...row, revokedAt: "2026-11-04T11:00:00.000Z" }
					: row,
			)
			await route.fulfill({
				json: {
					...activeKey,
					revokedAt: "2026-11-04T11:00:00.000Z",
				},
			})
		})

		await page.goto("/account")
		await expect(
			page.getByRole("heading", { name: "API keys and account" }),
		).toBeVisible()
		await expect(page.getByTestId("api-keys-table")).toContainText("CI runner")
		await expect(page.getByTestId("api-keys-table")).toContainText(
			"fp_test_abcd",
		)

		await page.getByTestId("api-key-label").fill("Laptop")
		await page.getByTestId("api-key-create").click()
		const once = page.getByTestId("api-key-once")
		await expect(once).toContainText("will not be shown again")
		await expect(page.getByTestId("api-key-secret")).toHaveText(
			"fp_test_new1_secret_shown_once_only",
		)
		await page.getByTestId("api-key-copy").click()
		await expect(
			page.getByRole("status").filter({ hasText: "Copied" }),
		).toBeVisible()

		await page.getByTestId("api-key-revoke-key_active").click()
		await expect(page.getByTestId("api-key-revoke-confirm")).toBeVisible()
		await page.getByTestId("api-key-revoke-yes").click()
		await expect(page.getByTestId("api-keys-table")).toContainText("Revoked")
	})

	test("change password posts to Better Auth and shows clear errors", async ({
		page,
	}) => {
		await mockSessionShell(page)
		await page.route(/\/v1\/api-keys$/, (route) =>
			route.fulfill({ json: { keys: [] } }),
		)
		let body: unknown = null
		await page.route(/\/api\/auth\/change-password$/, async (route) => {
			body = route.request().postDataJSON()
			const payload = body as {
				currentPassword?: string
				newPassword?: string
			}
			if (payload.currentPassword === "wrong-password") {
				await route.fulfill({
					status: 400,
					json: { code: "INVALID_PASSWORD", message: "Invalid password" },
				})
				return
			}
			await route.fulfill({
				json: { token: null, user: { id: "u1", email: "ana@example.com" } },
			})
		})

		await page.goto("/account")
		const form = page.getByTestId("change-password-form")
		await form.getByLabel("Current password").fill("wrong-password")
		await form
			.getByLabel("New password", { exact: true })
			.fill("new-password-1")
		await form.getByLabel("Confirm new password").fill("new-password-1")
		await page.getByTestId("change-password-submit").click()
		await expect(page.getByTestId("change-password-error")).toHaveText(
			"Invalid password",
		)
		expect(body).toEqual({
			currentPassword: "wrong-password",
			newPassword: "new-password-1",
		})

		await form.getByLabel("Current password").fill("old-password-1")
		await form.getByLabel("New password", { exact: true }).fill("short")
		await form.getByLabel("Confirm new password").fill("short")
		await page.getByTestId("change-password-submit").click()
		await expect(page.getByTestId("change-password-error")).toContainText(
			"at least 10 characters",
		)

		await form.getByLabel("Current password").fill("old-password-1")
		await form
			.getByLabel("New password", { exact: true })
			.fill("new-password-1")
		await form.getByLabel("Confirm new password").fill("different-pass")
		await page.getByTestId("change-password-submit").click()
		await expect(page.getByTestId("change-password-error")).toContainText(
			"do not match",
		)

		await form.getByLabel("Confirm new password").fill("new-password-1")
		await page.getByTestId("change-password-submit").click()
		await expect(page.getByTestId("change-password-success")).toHaveText(
			"Password updated.",
		)
	})

	test("sidebar reaches Account", async ({ page }) => {
		await mockSessionShell(page)
		await page.route(/\/v1\/api-keys$/, (route) =>
			route.fulfill({ json: { keys: [] } }),
		)
		await page.goto("/dashboard")
		await page
			.getByRole("navigation", { name: "Primary" })
			.getByRole("link", { name: "Account" })
			.click()
		await expect(page).toHaveURL(/\/account$/)
		await expect(
			page.getByRole("heading", { name: "API keys and account" }),
		).toBeVisible()
		await expect(
			page
				.getByTestId("change-password-form")
				.getByText("At least 10 characters."),
		).toBeVisible()
	})
})
