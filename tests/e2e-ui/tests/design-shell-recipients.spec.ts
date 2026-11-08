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
	test("sidebar reaches Recipients and theme toggle cycles", async ({
		page,
	}) => {
		await mockDirectory(page)
		await page.goto("/")
		const nav = page.getByRole("navigation", { name: "Primary" })
		await expect(nav.getByRole("link", { name: "People" })).toBeVisible()
		await nav.getByRole("link", { name: "People" }).click()
		await expect(page).toHaveURL(/\/recipients$/)
		await expect(
			page.getByRole("heading", { name: "Recipients", exact: true }),
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
		await expect(page.getByTestId("recipients-table")).toContainText("Worker A")
		await expect(page.getByTestId("recipients-table")).toContainText("rcp_demo")
		await expect(page.getByTestId("endpoints-table")).toContainText("E-wallet")
		await expect(page.getByTestId("endpoints-table")).toContainText(
			"phoneNumber: ••••1234",
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
		await page.getByRole("button", { name: "Add recipient" }).click()
		await expect(page.getByTestId("recipients-table")).toContainText("Worker B")
		await expect(page.getByTestId("recipients-table")).toContainText("rcp_new")

		const endpointForm = page.getByTestId("endpoint-form")
		await endpointForm.getByLabel("Type").selectOption("bank_account")
		await endpointForm.getByLabel("Country").selectOption("PH")
		await expect(endpointForm.getByLabel("Currency")).toHaveValue("PHP")
		await endpointForm.getByLabel("Account number").fill("PH-DEMO-ACCOUNT-9")
		await endpointForm.getByLabel("Bank name").fill("BDO")
		await page.getByRole("button", { name: "Add endpoint" }).click()
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
})
