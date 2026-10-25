import { test, expect, type Page } from "@playwright/test"

const now = (offsetMs = 0): string =>
	new Date(Date.now() + offsetMs).toISOString()

const claimFixture = (overrides: Record<string, unknown> = {}) => ({
	paymentId: "pay_claim_1",
	status: "open",
	paymentStatus: "processing",
	expiresAt: now(120_000),
	amount: { amount: "250000000", currency: "USDC" },
	corridor: {
		from: { country: "US", currency: "USD" },
		to: { country: "PH", currency: "PHP" },
	},
	allowedDestinationTypes: ["crypto_wallet"],
	simulated: true,
	...overrides,
})

type ClaimFixture = ReturnType<typeof claimFixture>

interface MockOptions {
	claim?: ClaimFixture
	getError?: { status: number; body: unknown }
	failFirstGet?: boolean
	acceptError?: { status: number; body: unknown }
	acceptFailOnce?: boolean
	acceptDelayMs?: number
	alwaysProcessing?: boolean
	pollToPaid?: boolean
}

async function mockClaimApi(page: Page, options: MockOptions = {}) {
	let current = options.claim ?? claimFixture()
	let accepted = false
	let getCount = 0
	let acceptCount = 0
	let recovered = false
	let acceptBody: unknown
	let acceptKey = ""
	let getAuthHeader: string | undefined
	let acceptAuthHeader: string | undefined
	const acceptKeys: string[] = []

	await page.route(/\/v1\/claims\/claim_token_1$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		getCount += 1
		getAuthHeader = route.request().headers()["authorization"]
		if (options.getError && (!options.failFirstGet || !recovered)) {
			await route.fulfill({
				status: options.getError.status,
				json: options.getError.body,
			})
			return
		}
		if (options.pollToPaid && getCount > 1) {
			current = { ...current, paymentStatus: "paid" }
		}
		if (accepted && !options.alwaysProcessing) {
			current = {
				...current,
				status: "accepted",
				paymentStatus: "paid",
			}
		}

		await route.fulfill({ json: current })
	})

	await page.route(/\/v1\/claims\/claim_token_1\/accept$/, async (route) => {
		acceptCount += 1
		acceptAuthHeader = route.request().headers()["authorization"]
		acceptBody = route.request().postDataJSON()
		acceptKey = route.request().headers()["idempotency-key"] ?? ""
		acceptKeys.push(acceptKey)
		if (options.acceptDelayMs)
			await new Promise((resolve) => setTimeout(resolve, options.acceptDelayMs))
		if (options.acceptError && (!options.acceptFailOnce || acceptCount === 1)) {
			await route.fulfill({
				status: options.acceptError.status,
				json: options.acceptError.body,
			})
			return
		}
		accepted = true
		current = { ...current, status: "accepted", paymentStatus: "processing" }
		await route.fulfill({
			json: {
				claim: current,
				paymentId: current.paymentId,
				paymentStatus: "processing",
			},
		})
	})

	return {
		getCount: () => getCount,
		acceptCount: () => acceptCount,
		acceptBody: () => acceptBody,
		acceptKey: () => acceptKey,
		acceptKeys: () => acceptKeys,
		getAuthHeader: () => getAuthHeader,
		acceptAuthHeader: () => acceptAuthHeader,
		recover: () => {
			recovered = true
		},
	}
}

async function openClaim(page: Page) {
	await page.goto("/claim/claim_token_1")
	await expect(
		page.getByRole("heading", { name: "Claim your payment" }),
	).toBeVisible()
}

test.describe("CF4 claim page", () => {
	test.use({ viewport: { width: 390, height: 844 } })

	test("loads the API claim and accepts a crypto endpoint once", async ({
		page,
	}) => {
		const consoleMessages: string[] = []
		page.on("console", (message) => consoleMessages.push(message.text()))
		const counts = await mockClaimApi(page)
		await openClaim(page)

		await expect(page.getByText("25.00")).toBeVisible()
		await expect(page.getByText(/US → PH/)).toBeVisible()
		await expect(
			page.getByText(/Fee and net are not fields of the public claim view/),
		).toBeVisible()
		await expect(
			page.getByRole("button", { name: "Accept payment" }),
		).toBeDisabled()

		await page.getByRole("radio", { name: /Crypto wallet/ }).check()
		await expect(page.getByLabel("Stellar testnet wallet address")).toHaveValue(
			"",
		)
		await expect(
			page.getByRole("button", { name: /demo testnet address/i }),
		).toHaveCount(0)
		await page
			.getByLabel("Stellar testnet wallet address")
			.fill("GDEMOTESTNETADDRESSONLY000000000000000000000000000000000000")

		await expect(
			page.getByRole("button", { name: "Accept payment" }),
		).toBeEnabled()
		await page.getByRole("button", { name: "Accept payment" }).click()

		await expect(page.getByText("Claim Accepted")).toBeVisible()
		// Scoped: the accepted page also shows the anchor cash-out panel's payment status.
		await expect(
			page
				.locator(".claim-status-row")
				.getByText("Processing", { exact: true }),
		).toBeVisible()
		expect(counts.acceptCount()).toBe(1)
		expect(counts.acceptBody()).toEqual({
			endpoint: {
				type: "crypto_wallet",
				country: "",
				currency: "USDC",
				network: "stellar",
				details: {
					address:
						"GDEMOTESTNETADDRESSONLY000000000000000000000000000000000000",
				},
				simulated: true,
			},
		})
		expect(counts.acceptKey()).not.toBe("")
		expect(counts.getAuthHeader()).toBeUndefined()
		expect(counts.acceptAuthHeader()).toBeUndefined()

		await expect(
			page.getByText(/Paid: confirmed by the claim API/),
		).toBeVisible({
			timeout: 5_000,
		})
		// Wallet-kit metadata may exist, but the raw claim token must not be stored.
		const stored = await page.evaluate(() =>
			[...Object.entries(localStorage), ...Object.entries(sessionStorage)].map(
				([key, value]) => `${key}:${value}`,
			),
		)
		expect(stored.some((entry) => entry.includes("claim_token_1"))).toBe(false)
		expect(consoleMessages.join(" ")).not.toContain("claim_token_1")
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true)
	})

	test("fiat options stay visible but cannot be accepted until the API route supports them", async ({
		page,
	}) => {
		await mockClaimApi(page, {
			claim: claimFixture({
				amount: { amount: "1200000", currency: "PHP" },
				allowedDestinationTypes: ["bank_account", "ewallet"],
			}),
		})
		await openClaim(page)

		await expect(
			page.getByRole("radio", { name: /Bank account/ }),
		).toBeDisabled()
		await expect(page.getByRole("radio", { name: /E-wallet/ })).toBeDisabled()
		await expect(
			page.getByText(
				/claim API currently accepts crypto wallet endpoints only/,
			),
		).toBeVisible()
		await expect(
			page.getByText(/has no endpoint that the current claim API can accept/),
		).toBeVisible()
		await expect(
			page.getByRole("button", { name: "Accept payment" }),
		).toHaveCount(0)
		await expect(
			page.getByRole("radio", { name: /Crypto wallet/ }),
		).toHaveCount(0)
	})

	test("an already accepted claim resumes polling after reload", async ({
		page,
	}) => {
		const counts = await mockClaimApi(page, {
			claim: claimFixture({ status: "accepted", paymentStatus: "processing" }),
			pollToPaid: true,
		})
		await openClaim(page)

		await expect(page.getByText("Claim Accepted")).toBeVisible()
		await expect(
			page.getByText(/Paid: confirmed by the claim API/),
		).toBeVisible({ timeout: 5_000 })
		expect(counts.acceptCount()).toBe(0)
		expect(counts.getCount()).toBeGreaterThanOrEqual(2)
	})

	test("an expired claim has no accept action", async ({ page }) => {
		await mockClaimApi(page, {
			claim: claimFixture({
				status: "expired",
				paymentStatus: "expired",
				expiresAt: now(-60_000),
			}),
		})
		await openClaim(page)

		await expect(page.getByText(/This claim link has expired/)).toBeVisible()
		await expect(
			page.getByRole("button", { name: "Accept payment" }),
		).toHaveCount(0)
	})

	test("an invalid token shows the API error and no endpoint options", async ({
		page,
	}) => {
		await mockClaimApi(page, {
			getError: {
				status: 404,
				body: {
					code: "not_found",
					message: "This claim link is invalid or no longer exists.",
				},
			},
		})
		await page.goto("/claim/claim_token_1")

		await expect(
			page.getByText("This claim link is invalid or no longer exists."),
		).toBeVisible()
		await expect(page.getByRole("radio")).toHaveCount(0)
		await expect(
			page.getByRole("button", { name: "Accept payment" }),
		).toHaveCount(0)
	})

	test("an API load error can be retried without inventing a claim", async ({
		page,
	}) => {
		const counts = await mockClaimApi(page, {
			getError: {
				status: 500,
				body: { code: "internal", message: "Temporary claim failure." },
			},
			failFirstGet: true,
		})
		await page.goto("/claim/claim_token_1")
		await expect(page.getByText("Temporary claim failure.")).toBeVisible()

		counts.recover()
		await page.getByRole("button", { name: "Try again" }).click()
		await expect(page.getByText("25.00")).toBeVisible()
		await expect(
			page.getByRole("radio", { name: /Crypto wallet/ }),
		).toBeVisible()
	})

	test("a double click sends one accept request", async ({ page }) => {
		const counts = await mockClaimApi(page, { acceptDelayMs: 500 })
		await openClaim(page)
		await page.getByRole("radio", { name: /Crypto wallet/ }).check()
		await page
			.getByLabel("Stellar testnet wallet address")
			.fill("GDEMOTESTNETADDRESSONLY000000000000000000000000000000000000")

		await page.getByRole("button", { name: "Accept payment" }).dblclick()
		await expect(
			page.getByRole("button", { name: "Accepting…" }),
		).toBeDisabled()
		await expect(page.getByText("Claim Accepted")).toBeVisible()
		expect(counts.acceptCount()).toBe(1)
		expect(counts.acceptKey()).not.toBe("")
	})

	test("an accept conflict is shown without claiming success", async ({
		page,
	}) => {
		const counts = await mockClaimApi(page, {
			acceptError: {
				status: 409,
				body: { code: "state_conflict", message: "Claim is no longer open." },
			},
		})
		await openClaim(page)
		await page.getByRole("radio", { name: /Crypto wallet/ }).check()
		await page
			.getByLabel("Stellar testnet wallet address")
			.fill("GDEMOTESTNETADDRESSONLY000000000000000000000000000000000000")
		await page.getByRole("button", { name: "Accept payment" }).click()

		await expect(page.getByTestId("claim-accept-error")).toHaveText(
			"Claim is no longer open.",
		)
		await expect(page.getByText("Claim Accepted")).toHaveCount(0)
		expect(counts.acceptCount()).toBe(1)
	})

	test("Accept stays disabled while paymentStatus is funded", async ({
		page,
	}) => {
		const counts = await mockClaimApi(page, {
			claim: claimFixture({ paymentStatus: "funded" }),
		})
		await openClaim(page)
		await expect(page.getByText("Funded", { exact: true })).toBeVisible()
		await expect(
			page.getByText(/not ready to accept yet.*processing/i),
		).toBeVisible()

		await page.getByRole("radio", { name: /Crypto wallet/ }).check()
		await page
			.getByLabel("Stellar testnet wallet address")
			.fill("GDEMOTESTNETADDRESSONLY000000000000000000000000000000000000")

		await expect(page.getByTestId("claim-accept")).toBeDisabled()
		await page.getByTestId("claim-accept").click({ force: true })
		expect(counts.acceptCount()).toBe(0)
		await expect(page.getByText("Claim Accepted")).toHaveCount(0)
	})

	test("409 invalid_state is shown and never treated as success", async ({
		page,
	}) => {
		const counts = await mockClaimApi(page, {
			acceptError: {
				status: 409,
				body: {
					code: "invalid_state",
					message: "Payment is not ready for claim accept.",
				},
			},
		})
		await openClaim(page)
		await page.getByRole("radio", { name: /Crypto wallet/ }).check()
		await page
			.getByLabel("Stellar testnet wallet address")
			.fill("GDEMOTESTNETADDRESSONLY000000000000000000000000000000000000")
		await page.getByTestId("claim-accept").click()

		await expect(page.getByTestId("claim-accept-error")).toHaveText(
			"Payment is not ready for claim accept.",
		)
		await expect(page.getByText("Claim Accepted")).toHaveCount(0)
		expect(counts.acceptCount()).toBe(1)
	})

	test("a retry reuses the accept idempotency key", async ({ page }) => {
		const counts = await mockClaimApi(page, {
			acceptError: {
				status: 500,
				body: { code: "internal", message: "Temporary accept failure." },
			},
			acceptFailOnce: true,
		})
		await openClaim(page)
		await page.getByRole("radio", { name: /Crypto wallet/ }).check()
		await page
			.getByLabel("Stellar testnet wallet address")
			.fill("GDEMOTESTNETADDRESSONLY000000000000000000000000000000000000")

		await page.getByRole("button", { name: "Accept payment" }).click()
		await expect(page.getByText("Temporary accept failure.")).toBeVisible()
		await page.getByRole("button", { name: "Accept payment" }).click()
		await expect(page.getByText("Claim Accepted")).toBeVisible()

		expect(counts.acceptCount()).toBe(2)
		expect(counts.acceptKeys()[0]).not.toBe("")
		expect(counts.acceptKeys()[0]).toBe(counts.acceptKeys()[1])
	})

	test("polling stops when the claim page is left", async ({ page }) => {
		const counts = await mockClaimApi(page, { alwaysProcessing: true })
		await openClaim(page)
		await page.getByRole("radio", { name: /Crypto wallet/ }).check()
		await page
			.getByLabel("Stellar testnet wallet address")
			.fill("GDEMOTESTNETADDRESSONLY000000000000000000000000000000000000")
		await page.getByRole("button", { name: "Accept payment" }).click()
		await expect(page.getByText("Claim Accepted")).toBeVisible()
		await page.waitForTimeout(2_300)
		expect(counts.getCount()).toBeGreaterThanOrEqual(2)

		await page.goto("/")
		await page.waitForTimeout(500)
		const afterNavigation = counts.getCount()
		await page.waitForTimeout(2_300)
		expect(counts.getCount()).toBe(afterNavigation)
	})
})
