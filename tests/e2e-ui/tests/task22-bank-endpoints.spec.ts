import { expect, test, type Page } from "@playwright/test"
import {
	paymentDetailFixture,
	paymentFromDetail,
	quoteFixture,
} from "./fixtures"

const CORRIDORS = {
	corridors: [
		{
			from: { country: "GB", currency: "GBP" },
			to: { country: "PH", currency: "PHP" },
			allowedDestinationTypes: ["bank_account", "ewallet"],
			recipientKinds: ["individual", "company"],
			regulationNote: "Cross-border GBP to PHP.",
			simulated: true,
			legsAvailable: {
				collect: ["sim_bank_gb_fps"],
				convert: ["sim_fx"],
				settle: ["solana_tgbp"],
				payout: ["tazapay_sandbox"],
			},
		},
	],
}

const SAVED_RECIPIENT = {
	id: "rcp_saved",
	name: "Worker Saved",
	kind: "individual",
	country: "PH",
	createdAt: "2026-11-01T12:00:00.000Z",
}

const BANK_A = {
	id: "end_bank_a",
	organizationId: "org_demo",
	recipientId: "rcp_saved",
	type: "bank_account",
	country: "PH",
	currency: "PHP",
	network: null,
	details: {
		accountNumber: "********3210",
		bankName: "BDO",
	},
	simulated: true as const,
	createdAt: "2026-11-01T12:05:00.000Z",
}

const BANK_B = {
	id: "end_bank_b",
	organizationId: "org_demo",
	recipientId: "rcp_saved",
	type: "bank_account",
	country: "PH",
	currency: "PHP",
	network: null,
	details: {
		accountNumber: "********9988",
		bankName: "BPI",
	},
	simulated: true as const,
	createdAt: "2026-11-01T12:06:00.000Z",
}

function maskLikeApi(value: string): string {
	if (value.length <= 4) return "*".repeat(Math.max(value.length, 4))
	return `${"*".repeat(Math.min(value.length - 4, 12))}${value.slice(-4)}`
}

async function mockTask22(
	page: Page,
	opts: {
		recipients?: unknown[]
		endpoints?: unknown[]
		legErrorMessage?: string
	} = {},
) {
	const state = {
		recipients: [...(opts.recipients ?? [])],
		endpoints: [...(opts.endpoints ?? [])],
		endpointBodies: [] as Array<Record<string, unknown>>,
		paymentBodies: [] as Array<Record<string, unknown>>,
	}

	await page.route(/\/v1\/corridors$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ json: CORRIDORS })
	})
	await page.route(/\/v1\/recipients$/, async (route) => {
		const method = route.request().method()
		if (method === "GET") {
			await route.fulfill({ json: { recipients: state.recipients } })
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
				createdAt: "2026-11-06T12:00:00.000Z",
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
			const url = new URL(route.request().url())
			const recipientId = url.searchParams.get("recipientId")
			const endpoints = recipientId
				? state.endpoints.filter(
						(entry) =>
							(entry as { recipientId: string }).recipientId === recipientId,
					)
				: state.endpoints
			await route.fulfill({ json: { endpoints } })
			return
		}
		if (method === "POST") {
			const body = route.request().postDataJSON() as Record<string, unknown>
			state.endpointBodies.push(body)
			const details = body.details as Record<string, string>
			const masked: Record<string, string> = {}
			for (const [key, value] of Object.entries(details)) {
				masked[key] = maskLikeApi(value)
			}
			const created = {
				id: "end_created",
				organizationId: "org_demo",
				recipientId: body.recipientId,
				type: body.type,
				country: body.country,
				currency: body.currency,
				network: body.network,
				details: masked,
				simulated: true as const,
				createdAt: "2026-11-06T12:01:00.000Z",
			}
			state.endpoints = [created, ...state.endpoints]
			await route.fulfill({ status: 201, json: created })
			return
		}
		return route.fallback()
	})
	await page.route(/\/v1\/quotes$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback()
		const body = route.request().postDataJSON() as Record<string, unknown>
		const base = quoteFixture()
		await route.fulfill({
			json: {
				...base,
				id: "quo_bank_1",
				source: body.source,
				destination: body.destination,
				amount: body.amount,
				fees: {
					...base.fees,
					total: { amount: "10", currency: "GBP" },
				},
			},
		})
	})
	await page.route(/\/v1\/payments$/, async (route) => {
		if (route.request().method() !== "POST") return route.fallback()
		const body = route.request().postDataJSON() as Record<string, unknown>
		state.paymentBodies.push(body)
		const detail = paymentDetailFixture("awaiting_funds")
		await route.fulfill({
			status: 201,
			json: {
				...paymentFromDetail(detail),
				id: "pay_bank_1",
				quoteId: "quo_bank_1",
				recipientId: body.recipientId,
			},
		})
	})
	await page.route(/\/v1\/payments\/pay_bank_1$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		const detail = paymentDetailFixture("failed")
		if (opts.legErrorMessage) {
			const payout = detail.legs.find((leg) => leg.kind === "payout")
			if (payout?.error) {
				payout.error = {
					code: "unsupported",
					message: opts.legErrorMessage,
				}
			}
		}
		await route.fulfill({ json: { ...detail, id: "pay_bank_1" } })
	})

	return state
}

async function fillBankQuote(page: Page) {
	await page.getByLabel("Destination country").selectOption("PH")
	await page.getByLabel("Destination", { exact: true }).selectOption({
		label: "Bank account",
	})
	await page.getByLabel("Who pays the fee?").selectOption({
		label: "I pay the fee (added on top)",
	})
	await page.getByLabel("Amount (£)").fill("10.00")
}

test.describe("TASK 22 bank endpoints", () => {
	test("new recipient + bank details creates endpoint then payment with endpointId", async ({
		page,
	}) => {
		const state = await mockTask22(page)
		await page.goto("/")
		await fillBankQuote(page)
		await page.getByRole("textbox", { name: "Recipient" }).fill("Worker New")
		await expect(page.getByTestId("bank-details")).toBeVisible()
		await page.getByLabel("Account number").fill("12345678903210")
		await page.getByLabel("Bank name").fill("BDO")
		await page.getByLabel("SWIFT/BIC").fill("BNORPHMM")

		await page.getByRole("button", { name: "Get quote" }).click()
		await expect(
			page.getByRole("heading", { name: "Chosen route" }),
		).toBeVisible()
		await page.getByRole("button", { name: "Create payment" }).click()
		await expect(page).toHaveURL(/\/payments\/pay_bank_1$/)

		await expect.poll(() => state.endpointBodies.length).toBe(1)
		expect(state.endpointBodies[0]).toMatchObject({
			recipientId: "rcp_new",
			type: "bank_account",
			country: "PH",
			currency: "PHP",
			network: null,
			simulated: true,
			details: {
				accountNumber: "12345678903210",
				bankName: "BDO",
				swiftCode: "BNORPHMM",
			},
		})
		await expect.poll(() => state.paymentBodies.length).toBe(1)
		expect(state.paymentBodies[0]).toMatchObject({
			quoteId: "quo_bank_1",
			recipientId: "rcp_new",
			endpointId: "end_created",
		})
	})

	test("saved recipient with two banks lets you pick one endpointId", async ({
		page,
	}) => {
		const state = await mockTask22(page, {
			recipients: [SAVED_RECIPIENT],
			endpoints: [BANK_A, BANK_B],
		})
		await page.goto("/")
		// Country first: changing country clears the saved recipient.
		await fillBankQuote(page)
		await page.getByLabel("Saved recipient").selectOption("rcp_saved")
		const picker = page.getByTestId("bank-endpoint")
		await expect(picker).toBeVisible()
		await expect(picker).toContainText("BDO ••3210")
		await expect(picker).toContainText("BPI ••9988")
		await picker.selectOption("end_bank_b")
		await expect(page.getByTestId("bank-details")).toHaveCount(0)

		await page.getByRole("button", { name: "Get quote" }).click()
		await expect(
			page.getByRole("heading", { name: "Chosen route" }),
		).toBeVisible()
		await page.getByRole("button", { name: "Create payment" }).click()
		await expect(page).toHaveURL(/\/payments\/pay_bank_1$/)

		expect(state.endpointBodies).toHaveLength(0)
		await expect.poll(() => state.paymentBodies.length).toBe(1)
		expect(state.paymentBodies[0]).toMatchObject({
			recipientId: "rcp_saved",
			endpointId: "end_bank_b",
		})
	})

	test("recipients page shows masked bank accounts and never the clear number", async ({
		page,
	}) => {
		await mockTask22(page, {
			recipients: [SAVED_RECIPIENT],
			endpoints: [BANK_A],
		})
		await page.goto("/recipients")
		await expect(page.getByTestId("endpoints-table")).toContainText(
			"BDO ••3210",
		)
		await expect(page.getByTestId("endpoints-table")).not.toContainText(
			"12345678903210",
		)
		const bankForm = page.getByTestId("recipient-bank-details")
		await expect(bankForm).toBeVisible()
		await page
			.getByTestId("endpoint-form")
			.getByLabel("Country")
			.selectOption("PH")
		await bankForm.getByLabel("Account number").fill("998877665544")
		await bankForm.getByLabel("Bank name").fill("BDO")
		await page.getByRole("button", { name: "Save way to get paid" }).click()
		// API masks short bank names fully ("BDO" → "****") so the label falls back to Bank.
		await expect(page.getByTestId("endpoints-table")).toContainText(
			"Bank ••5544",
		)
		await expect(page.getByTestId("endpoints-table")).not.toContainText(
			"998877665544",
		)
	})

	test("missing-field payout leg error shows plain English", async ({
		page,
	}) => {
		await mockTask22(page, {
			legErrorMessage:
				"Tazapay beneficiary for endpoint end_1 is missing swiftCode; required_bank_codes: swift_code",
		})
		await page.goto("/payments/pay_bank_1")
		await expect(page.getByTestId("leg-error")).toHaveText(
			"The bank needs: SWIFT/BIC",
		)
		await expect(page.getByTestId("leg-error")).not.toContainText("swiftCode")
	})

	test("390px: Send bank details and Recipients stay in width", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 })
		await mockTask22(page, {
			recipients: [SAVED_RECIPIENT],
			endpoints: [BANK_A, BANK_B],
		})

		const noSideways = async () => {
			const metrics = await page.evaluate(() => ({
				scrollWidth: document.documentElement.scrollWidth,
				innerWidth: window.innerWidth,
			}))
			expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth)
		}

		await page.goto("/")
		await fillBankQuote(page)
		await page.getByLabel("Saved recipient").selectOption("rcp_saved")
		await expect(page.getByTestId("bank-endpoint")).toBeVisible()
		await page.getByTestId("bank-endpoint").selectOption("__new__")
		await expect(page.getByTestId("bank-details")).toBeVisible()
		await page.getByTestId("bank-details-more").click()
		await expect(page.getByTestId("bank-details-extra")).toBeVisible()
		await noSideways()

		await page.goto("/recipients")
		await expect(page.getByTestId("recipient-bank-details")).toBeVisible()
		await noSideways()
	})
})
