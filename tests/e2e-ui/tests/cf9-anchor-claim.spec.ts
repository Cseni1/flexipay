import { expect, test, type Page } from "@playwright/test"
import { classifyProxyRequest } from "../../../apps/web/vite.proxy.ts"
import {
	anchorOutcomeLabel,
	anchorStatusKind,
	initialAnchorFlow,
	shouldPollAnchor,
} from "../../../apps/web/src/components/claim/anchor-claim-flow.ts"

// CF9 covers the M1 reference-anchor cash-out UI against CCR-22 shapes. Fixture PASS is not a
// real anchor run: no test anchor, SEP-10 session or bank payout is contacted here. The hosted
// URL in these fixtures deliberately carries a session token, to prove the page never renders,
// logs or stores it.

const now = (offsetMs = 0): string =>
	new Date(Date.now() + offsetMs).toISOString()

const claimFixture = (overrides: Record<string, unknown> = {}) => ({
	paymentId: "pay_anchor_1",
	status: "open",
	paymentStatus: "processing",
	expiresAt: now(120_000),
	amount: { amount: "50000000", currency: "USDC" },
	corridor: {
		from: { country: "US", currency: "USD" },
		to: { country: "PH", currency: "PHP" },
	},
	allowedDestinationTypes: ["crypto_wallet"],
	simulated: true,
	...overrides,
})

const acceptedClaim = (overrides: Record<string, unknown> = {}) =>
	claimFixture({ status: "accepted", ...overrides })

const priceBody = (overrides: Record<string, unknown> = {}) => ({
	indicative: true,
	context: "sep6",
	sellAmount: "5",
	buyAmount: "4.95",
	buyAsset: "iso4217:USD",
	sellAsset: "stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
	price: "0.99",
	...overrides,
})

const HOSTED_TOKEN = "sep24-session-token-must-not-leak"
const withdrawBody = () => ({
	anchorTxId: "anchor_tx_1",
	urlSanitised: `https://testanchor.stellar.org/sep24/interactive?token=${HOSTED_TOKEN}`,
	kind: "withdrawal",
})

const statusBody = (status: string) => ({
	anchorTxId: "anchor_tx_1",
	status,
	amountIn: "5",
	withdrawAnchorAccount:
		"GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
	withdrawMemoPresent: true,
})

interface MockOptions {
	claim?: Record<string, unknown>
	price?: { status: number; body: unknown }
	/** Consumed in order; the last entry is reused. */
	withdraw?: Array<{ status: number; body: unknown }>
	/** Consumed in order; the last entry is reused. */
	status?: Array<{ status: number; body: unknown }>
	/** Abort the first withdraw POST as a network failure. */
	abortFirstWithdraw?: boolean
	withdrawDelayMs?: number
}

async function mockAnchorApi(page: Page, options: MockOptions = {}) {
	const claim = options.claim ?? claimFixture()
	let priceCount = 0
	let withdrawCount = 0
	let statusCount = 0
	const priceAuth: Array<string | undefined> = []
	const withdrawAuth: Array<string | undefined> = []
	const statusAuth: Array<string | undefined> = []
	const withdrawKeys: string[] = []
	const withdrawBodies: unknown[] = []

	await page.route(/\/v1\/claims\/claim_anchor_1$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ json: claim })
	})

	await page.route(
		/\/v1\/claims\/claim_anchor_1\/anchor\/indicative-price$/,
		async (route) => {
			priceCount += 1
			priceAuth.push(route.request().headers()["authorization"])
			const price = options.price ?? { status: 200, body: priceBody() }
			await route.fulfill({ status: price.status, json: price.body })
		},
	)

	await page.route(
		/\/v1\/claims\/claim_anchor_1\/anchor\/withdraw$/,
		async (route) => {
			if (route.request().method() !== "POST") return route.fallback()
			withdrawCount += 1
			withdrawAuth.push(route.request().headers()["authorization"])
			withdrawKeys.push(route.request().headers()["idempotency-key"] ?? "")
			withdrawBodies.push(route.request().postDataJSON())
			if (options.abortFirstWithdraw && withdrawCount === 1) {
				await route.abort("failed")
				return
			}
			if (options.withdrawDelayMs)
				await new Promise((resolve) =>
					setTimeout(resolve, options.withdrawDelayMs),
				)
			const queue = options.withdraw ?? [
				{ status: 200, body: withdrawBody() },
			]
			const next = queue[Math.min(withdrawCount - 1, queue.length - 1)]!
			await route.fulfill({ status: next.status, json: next.body })
		},
	)

	await page.route(
		/\/v1\/claims\/claim_anchor_1\/anchor\/withdraw\/[^/]+$/,
		async (route) => {
			if (route.request().method() !== "GET") return route.fallback()
			statusCount += 1
			statusAuth.push(route.request().headers()["authorization"])
			const queue = options.status ?? [
				{ status: 200, body: statusBody("pending_user_transfer_start") },
			]
			const next = queue[Math.min(statusCount - 1, queue.length - 1)]!
			await route.fulfill({ status: next.status, json: next.body })
		},
	)

	return {
		get priceCount() {
			return priceCount
		},
		get withdrawCount() {
			return withdrawCount
		},
		get statusCount() {
			return statusCount
		},
		priceAuth,
		withdrawAuth,
		statusAuth,
		withdrawKeys,
		withdrawBodies,
	}
}

test.use({ viewport: { width: 390, height: 844 } })

test.describe("CF9 anchor cash-out option", () => {
	test("shows the indicative price, requires the vault release first, and keeps crypto working", async ({
		page,
	}) => {
		const consoleMessages: string[] = []
		page.on("console", (message) => consoleMessages.push(message.text()))
		const mock = await mockAnchorApi(page)

		await page.goto("/claim/claim_anchor_1")
		const anchorOption = page.getByTestId("claim-anchor-option")
		await expect(
			anchorOption.getByRole("radio", {
				name: /Cash out to bank \(reference anchor\)/,
			}),
		).toBeEnabled()
		await anchorOption.getByRole("radio").check()

		await expect(page.getByTestId("anchor-panel")).toBeVisible()
		await expect(page.getByTestId("anchor-indicative-badge")).toHaveText(
			/Indicative/,
		)
		await expect(page.getByTestId("anchor-quote")).toContainText("5")
		await expect(page.getByTestId("anchor-quote")).toContainText("4.95")
		await expect(
			page.getByText(/Reference anchor on testnet/).first(),
		).toBeVisible()
		await expect(page.getByTestId("anchor-release-required")).toBeVisible()
		await expect(page.getByTestId("anchor-start")).toBeDisabled()
		// Nothing is marked as a completed cash-out before the anchor says so.
		await expect(page.getByTestId("anchor-status")).toContainText("Not started")
		await expect(page.getByText(/^Completed$/)).toHaveCount(0)

		// Every anchor call is a public claim call: no Authorization header.
		expect(mock.priceAuth.every((value) => value === undefined)).toBe(true)
		expect(mock.withdrawCount).toBe(0)

		// The crypto fallback still works from the same option list.
		await page.getByRole("radio", { name: /Crypto wallet/ }).check()
		await expect(page.getByTestId("anchor-panel")).toHaveCount(0)
		await expect(page.getByTestId("claim-accept")).toBeVisible()

		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true)
		expect(consoleMessages.join(" ")).not.toContain(HOSTED_TOKEN)
	})
})

test.describe("CF9 anchor withdrawal", () => {
	test("starts one withdrawal, polls the anchor status and never opens a fake hosted link", async ({
		page,
	}) => {
		const consoleMessages: string[] = []
		page.on("console", (message) => consoleMessages.push(message.text()))
		const mock = await mockAnchorApi(page, {
			claim: acceptedClaim(),
			status: [
				{ status: 200, body: statusBody("pending_user_transfer_start") },
			],
		})

		await page.goto("/claim/claim_anchor_1")
		await expect(page.getByTestId("anchor-accepted-block")).toBeVisible()
		await expect(page.getByTestId("anchor-start")).toBeEnabled()
		await page.getByTestId("anchor-start").click()

		await expect(page.getByTestId("anchor-tx-id")).toHaveText("anchor_tx_1")
		await expect(page.getByTestId("anchor-hosted-blocked")).toBeVisible()
		await expect(page.getByTestId("anchor-hosted-blocked")).toContainText(
			/sanitised hosted link/,
		)
		// The hosted URL is not rendered, and its session token is nowhere on the page.
		await expect(page.locator("body")).not.toContainText(HOSTED_TOKEN)
		await expect(page.locator("body")).not.toContainText(
			"testanchor.stellar.org/sep24/interactive",
		)

		// Anchor leg stays pending; the payment leg is shown separately.
		await expect(page.getByTestId("anchor-status")).toContainText("Pending")
		await expect(page.getByTestId("anchor-status")).toHaveAttribute(
			"data-anchor-status",
			"pending_user_transfer_start",
		)
		await expect(page.getByTestId("anchor-status-raw")).toContainText(
			"pending_user_transfer_start",
		)
		await expect(page.getByText(/^Completed$/)).toHaveCount(0)

		expect(mock.withdrawCount).toBe(1)
		expect(mock.withdrawKeys[0]).toBeTruthy()
		expect(mock.withdrawBodies[0]).toEqual({ amount: "5" })
		expect(mock.withdrawAuth.every((value) => value === undefined)).toBe(true)
		expect(mock.statusAuth.every((value) => value === undefined)).toBe(true)
		expect(mock.statusCount).toBeGreaterThanOrEqual(1)

		const stored = await page.evaluate(() => ({
			local: JSON.stringify({ ...localStorage }),
			session: JSON.stringify({ ...sessionStorage }),
		}))
		expect(stored.local).not.toContain("anchor_tx_1")
		expect(stored.local).not.toContain(HOSTED_TOKEN)
		expect(stored.session).not.toContain("anchor_tx_1")
		expect(stored.session).not.toContain(HOSTED_TOKEN)
		expect(consoleMessages.join(" ")).not.toContain(HOSTED_TOKEN)
		expect(consoleMessages.join(" ")).not.toContain("claim_anchor_1")

		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true)
	})

	test("a double click sends one withdrawal and one idempotency key", async ({
		page,
	}) => {
		const mock = await mockAnchorApi(page, {
			claim: acceptedClaim(),
			withdrawDelayMs: 300,
		})
		await page.goto("/claim/claim_anchor_1")
		await expect(page.getByTestId("anchor-start")).toBeEnabled()

		// Two synchronous clicks before React re-renders exercise the in-flight guard.
		await page.getByTestId("anchor-start").evaluate((element) => {
			element.click()
			element.click()
		})
		await expect(page.getByTestId("anchor-tx-id")).toBeVisible()
		expect(mock.withdrawCount).toBe(1)
		expect(mock.withdrawKeys).toHaveLength(1)
	})

	test("a network retry reuses the same body and idempotency key", async ({
		page,
	}) => {
		const mock = await mockAnchorApi(page, {
			claim: acceptedClaim(),
			abortFirstWithdraw: true,
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()

		await expect(page.getByTestId("anchor-withdraw-error")).toBeVisible()
		await expect(page.getByTestId("anchor-withdraw-error")).toContainText(
			/same idempotency key/,
		)
		await page.getByTestId("anchor-retry").click()
		await expect(page.getByTestId("anchor-tx-id")).toBeVisible()

		expect(mock.withdrawCount).toBe(2)
		expect(mock.withdrawKeys[0]).toBe(mock.withdrawKeys[1])
		expect(mock.withdrawBodies[0]).toEqual(mock.withdrawBodies[1])
		expect(mock.withdrawKeys[0]).toBeTruthy()
	})
})

test.describe("CF9 anchor terminal states", () => {
	test("paid payment plus pending anchor is not a completed cash-out", async ({
		page,
	}) => {
		await mockAnchorApi(page, {
			claim: acceptedClaim({ paymentStatus: "paid" }),
			status: [{ status: 200, body: statusBody("pending_anchor") }],
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()

		await expect(page.getByTestId("anchor-status")).toContainText("Pending")
		await expect(page.getByTestId("anchor-legs")).toContainText("Paid")
		await expect(page.getByText(/^Completed$/)).toHaveCount(0)
		await expect(page.getByTestId("anchor-panel")).not.toContainText(
			/Bank payout complete/,
		)
	})

	test("only the anchor's completed status is shown as completed", async ({
		page,
	}) => {
		await mockAnchorApi(page, {
			claim: acceptedClaim({ paymentStatus: "paid" }),
			status: [{ status: 200, body: statusBody("completed") }],
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()

		await expect(page.getByTestId("anchor-status")).toContainText("Completed")
		await expect(page.getByTestId("anchor-status")).toHaveAttribute(
			"data-anchor-status",
			"completed",
		)
	})

	test("an anchor failure status is failed, not completed", async ({ page }) => {
		await mockAnchorApi(page, {
			claim: acceptedClaim({ paymentStatus: "paid" }),
			status: [{ status: 200, body: statusBody("error") }],
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()

		await expect(page.getByTestId("anchor-status")).toContainText("Failed")
		await expect(page.getByText(/^Completed$/)).toHaveCount(0)
	})
})

test.describe("CF9 anchor errors", () => {
	test("an expired claim disables the option and the start action", async ({
		page,
	}) => {
		await mockAnchorApi(page, {
			claim: claimFixture({ expiresAt: now(-60_000) }),
		})
		await page.goto("/claim/claim_anchor_1")
		await expect(page.getByTestId("claim-anchor-option")).toBeVisible()
		await expect(
			page.getByTestId("claim-anchor-option").getByRole("radio"),
		).toBeDisabled()
	})

	test("a 409 expired withdraw is reported honestly", async ({ page }) => {
		await mockAnchorApi(page, {
			claim: acceptedClaim(),
			withdraw: [
				{
					status: 409,
					body: { code: "expired", message: "claim link expired" },
				},
			],
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()
		await expect(page.getByTestId("anchor-withdraw-error")).toContainText(
			/expired/i,
		)
		await expect(page.getByTestId("anchor-start")).toBeDisabled()
		await expect(page.getByText(/^Completed$/)).toHaveCount(0)
	})

	test("422 amount_out_of_range and 409 invalid_state are shown as refusals", async ({
		page,
	}) => {
		await mockAnchorApi(page, {
			claim: acceptedClaim(),
			withdraw: [
				{
					status: 422,
					body: {
						code: "amount_out_of_range",
						message: "USDC major units must be between 1 and 10",
					},
				},
			],
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()
		await expect(page.getByTestId("anchor-withdraw-error")).toContainText(
			/1 to 10 USDC/,
		)
		await expect(page.getByTestId("anchor-tx-id")).toHaveCount(0)
	})

	test("409 invalid_state explains that the vault release is missing", async ({
		page,
	}) => {
		await mockAnchorApi(page, {
			claim: acceptedClaim(),
			withdraw: [
				{
					status: 409,
					body: {
						code: "invalid_state",
						message: "vault release to classic G… is required",
					},
				},
			],
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()
		await expect(page.getByTestId("anchor-withdraw-error")).toContainText(
			/vault release to a classic/,
		)
		await expect(page.getByTestId("anchor-retry")).toHaveCount(0)
	})

	test("502 withdraw is retryable with the same key", async ({ page }) => {
		const mock = await mockAnchorApi(page, {
			claim: acceptedClaim(),
			withdraw: [
				{
					status: 502,
					body: { code: "anchor_unavailable", message: "anchor down" },
				},
			],
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()
		await expect(page.getByTestId("anchor-retry")).toBeVisible()
		await page.getByTestId("anchor-retry").click()
		await expect(page.getByTestId("anchor-withdraw-error")).toBeVisible()
		expect(mock.withdrawKeys[0]).toBe(mock.withdrawKeys[1])
		expect(mock.withdrawCount).toBe(2)
	})

	test("an unavailable indicative price leaves no start action", async ({
		page,
	}) => {
		await mockAnchorApi(page, {
			claim: claimFixture(),
			price: { status: 502, body: { code: "anchor_unavailable", message: "down" } },
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("claim-anchor-option").getByRole("radio").check()
		await expect(page.getByTestId("anchor-quote-error")).toContainText(
			/unavailable/i,
		)
		await expect(page.getByTestId("anchor-start")).toBeDisabled()
	})

	test("an anchor claim amount outside 1–10 USDC is not offered", async ({
		page,
	}) => {
		await mockAnchorApi(page, {
			claim: claimFixture({ amount: { amount: "250000000", currency: "USDC" } }),
		})
		await page.goto("/claim/claim_anchor_1")
		await expect(
			page.getByTestId("claim-anchor-option").getByRole("radio"),
		).toBeDisabled()
		await expect(page.getByTestId("claim-anchor-option")).toContainText(
			/10 USDC maximum/,
		)
	})
})

test.describe("CF9 proxy and reducer contract", () => {
	test("the local proxy forwards exactly the three anchor claim routes", () => {
		expect(
			classifyProxyRequest(
				"POST",
				"/v1/claims/tok/anchor/indicative-price",
			),
		).toBe("claim")
		expect(classifyProxyRequest("POST", "/v1/claims/tok/anchor/withdraw")).toBe(
			"claim",
		)
		expect(
			classifyProxyRequest("GET", "/v1/claims/tok/anchor/withdraw/anchor_tx_1"),
		).toBe("claim")
		// Wrong verb, extra segments and other claim sub-routes stay closed.
		expect(classifyProxyRequest("GET", "/v1/claims/tok/anchor/withdraw")).toBeNull()
		expect(
			classifyProxyRequest("POST", "/v1/claims/tok/anchor/withdraw/anchor_tx_1"),
		).toBeNull()
		expect(
			classifyProxyRequest("POST", "/v1/claims/tok/anchor/withdraw/extra/path"),
		).toBeNull()
		expect(classifyProxyRequest("POST", "/v1/claims/tok/anchor/other")).toBeNull()
	})

	test("only completed is a successful anchor status", () => {
		expect(anchorStatusKind("completed")).toBe("completed")
		expect(anchorStatusKind("pending_anchor")).toBe("pending")
		expect(anchorStatusKind("pending_user_transfer_start")).toBe("pending")
		expect(anchorStatusKind("error")).toBe("failed")
		expect(anchorStatusKind("expired")).toBe("failed")
		expect(anchorStatusKind("some_future_status")).toBe("pending")

		const state = initialAnchorFlow("5")
		expect(anchorOutcomeLabel(state)).toBe("Not started")
		expect(shouldPollAnchor(state)).toBe(false)
	})
})
