import { expect, test, type Page } from "@playwright/test"

const corridorFixture = {
	corridors: [
		{
			from: { country: "US", currency: "USD" },
			to: { country: "PH", currency: "PHP" },
			allowedDestinationTypes: ["bank_account", "ewallet", "crypto_wallet"],
			recipientKinds: ["individual", "company"],
			regulationNote: "Cross-border USD to PHP.",
			simulated: true,
		},
		{
			from: { country: "US", currency: "USD" },
			to: { country: "BR", currency: "BRL" },
			allowedDestinationTypes: ["bank_account", "crypto_wallet"],
			recipientKinds: ["individual", "company"],
			regulationNote: "Cross-border USD to BRL.",
			simulated: true,
		},
	],
}

const recipientFixture = {
	id: "rcp_demo",
	name: "Worker A",
	kind: "individual",
	country: "PH",
	createdAt: "2026-11-01T12:00:00.000Z",
}

const endpointFixture = {
	id: "end_demo",
	organizationId: "org_demo",
	recipientId: "rcp_demo",
	type: "ewallet",
	country: "PH",
	currency: "PHP",
	network: null,
	details: { phoneNumber: "••••1234" },
	simulated: true as const,
	createdAt: "2026-11-01T12:05:00.000Z",
}

async function mockDirectory(
	page: Page,
	opts: {
		recipients?: unknown[]
		endpoints?: unknown[]
		corridorsStatus?: number
		listStatus?: number
	} = {},
) {
	const state = {
		recipients: [...(opts.recipients ?? [recipientFixture])],
		endpoints: [...(opts.endpoints ?? [endpointFixture])],
	}
	const corridorsStatus = opts.corridorsStatus ?? 200
	const listStatus = opts.listStatus ?? 200

	await page.route(/\/v1\/corridors$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ status: corridorsStatus, json: corridorFixture })
	})
	await page.route(/\/v1\/recipients$/, async (route) => {
		const method = route.request().method()
		if (method === "GET") {
			await route.fulfill({
				status: listStatus,
				json:
					listStatus === 200
						? { recipients: state.recipients }
						: { code: "internal_error", message: "boom" },
			})
			return
		}
		if (method === "POST") {
			const body = route.request().postDataJSON() as {
				name: string
				kind: string
				country: string
			}
			const created = {
				id: "rcp_new",
				name: body.name,
				kind: body.kind,
				country: body.country,
				createdAt: "2026-11-02T10:00:00.000Z",
			}
			state.recipients = [created, ...state.recipients]
			await route.fulfill({ status: 201, json: { id: created.id } })
			return
		}
		return route.fallback()
	})
	await page.route(/\/v1\/endpoints(\?.*)?$/, async (route) => {
		const method = route.request().method()
		if (method === "GET") {
			await route.fulfill({ status: 200, json: { endpoints: state.endpoints } })
			return
		}
		if (method === "POST") {
			const body = route.request().postDataJSON() as {
				recipientId: string
				type: string
				country: string
				currency: string
				network: string | null
				details: Record<string, string>
				simulated: true
			}
			const created = {
				id: "end_new",
				organizationId: "org_demo",
				recipientId: body.recipientId,
				type: body.type,
				country: body.country,
				currency: body.currency,
				network: body.network,
				details: body.details,
				simulated: true as const,
				createdAt: "2026-11-02T10:01:00.000Z",
			}
			state.endpoints = [created, ...state.endpoints]
			await route.fulfill({ status: 201, json: created })
			return
		}
		return route.fallback()
	})
}

test.describe("Design shell recipients", () => {
	test("sidebar reaches People and theme toggle cycles", async ({ page }) => {
		await mockDirectory(page)
		await page.goto("/")
		const nav = page.getByRole("navigation", { name: "Primary" })
		await expect(nav.getByRole("link", { name: "People" })).toBeVisible()
		await nav.getByRole("link", { name: "People" }).click()
		await expect(page).toHaveURL(/\/recipients$/)
		await expect(
			page.getByRole("heading", { name: "People", exact: true }),
		).toBeVisible()

		const toggle = page.getByTestId("theme-toggle")
		await expect(toggle).toContainText("Theme: system")
		await toggle.click()
		await expect(toggle).toContainText("Theme: light")
		await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
		await toggle.click()
		await expect(toggle).toContainText("Theme: dark")
		await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
	})

	test("lists recipients and endpoints from the API", async ({ page }) => {
		await mockDirectory(page)
		await page.goto("/recipients")
		await expect(
			page
				.getByTestId("recipients-table")
				.locator('[data-recipient-id="rcp_demo"]'),
		).toContainText("Worker A")
		await expect(page.getByTestId("recipients-table")).toContainText(
			"Philippines",
		)
		await expect(page.getByTestId("recipient-detail")).toContainText("rcp_demo")
		await expect(page.getByTestId("endpoints-table")).toContainText(
			"Mobile wallet",
		)
		await expect(page.getByTestId("endpoints-table")).toContainText(
			"Phone ••••1234",
		)
		await expect(
			page.getByTestId("endpoints-table").getByText("Simulated"),
		).toBeVisible()
	})

	test("creates a recipient and an endpoint through the API", async ({
		page,
	}) => {
		await mockDirectory(page, { endpoints: [] })
		await page.goto("/recipients")

		await page
			.getByRole("textbox", { name: "Name", exact: true })
			.fill("Worker B")
		await page.getByLabel("Country").first().selectOption("PH")
		await page.getByRole("button", { name: "Add person", exact: true }).click()
		await expect(
			page
				.getByTestId("recipients-table")
				.locator('[data-recipient-id="rcp_new"]'),
		).toContainText("Worker B")
		await expect(page.getByTestId("recipient-detail")).toContainText("rcp_new")

		const endpointForm = page.getByTestId("endpoint-form")
		await endpointForm
			.getByLabel("How they get paid")
			.selectOption("bank_account")
		await endpointForm.getByLabel("Country").selectOption("PH")
		await expect(endpointForm.getByLabel("Currency")).toHaveValue("PHP")
		await endpointForm.getByLabel("Account number").fill("PH-DEMO-ACCOUNT-9")
		await endpointForm.getByLabel("Bank name").fill("BDO")
		await page.getByRole("button", { name: "Save way to get paid" }).click()
		await expect(page.getByTestId("endpoints-table")).toContainText(
			"Bank account",
		)
		await expect(page.getByTestId("endpoints-table")).toContainText(
			"BDO ••NT-9",
		)
		await expect(page.getByTestId("endpoints-table")).not.toContainText(
			"PH-DEMO-ACCOUNT-9",
		)
	})

	test("explains an API failure", async ({ page }) => {
		await mockDirectory(page, { listStatus: 500 })
		await page.goto("/recipients")
		await expect(page.getByTestId("recipients-error")).toBeVisible()
		await expect(page.getByTestId("recipients-error")).toContainText(
			"Waking up the server",
		)
		await expect(page.getByTestId("recipients-error")).not.toContainText("{")
		await expect(page.getByTestId("recipients-error")).not.toContainText("boom")
	})

	test("390px: people are cards with a big Pay button and no sideways scroll", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 })
		await mockDirectory(page)
		await page.goto("/recipients")
		const pay = page
			.getByTestId("recipients-table")
			.getByRole("link", { name: "Pay Worker A" })
		await expect(pay).toBeVisible()
		const box = await pay.boundingBox()
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390)
		const metrics = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			innerWidth: window.innerWidth,
		}))
		expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth)
		await expect(pay).toHaveAttribute("href", "/?recipientId=rcp_demo")
	})
})
