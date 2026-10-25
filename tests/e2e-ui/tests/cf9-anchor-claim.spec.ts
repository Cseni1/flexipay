import { expect, test, type Page } from "@playwright/test"
import { classifyProxyRequest } from "../../../apps/web/vite.proxy.ts"
import {
	anchorOutcomeLabel,
	anchorStatusKind,
	initialAnchorFlow,
	shouldPollAnchor,
} from "../../../apps/web/src/components/claim/anchor-claim-flow.ts"

// CF9 covers the M1 reference-anchor cash-out UI against the final CCR-22 shapes. Fixture PASS is
// not a real anchor run: no test anchor, SEP-10 session, bank payout or on-chain payment happens
// here. The hosted URL in these fixtures carries a session token, to prove the page opens it from
// memory and never renders, logs or stores it.

const now = (offsetMs = 0): string =>
	new Date(Date.now() + offsetMs).toISOString()

const HASH_1 =
	"a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"
const HASH_2 =
	"b1c2d3e4f5061728394a5b6c7d8e9f01b1c2d3e4f5061728394a5b6c7d8e9f01"
const RELEASE_REF =
	"c1d2e3f405162738495a6b7c8d9e0f1c1d2e3f405162738495a6b7c8d9e0f1c"
const HOSTED_TOKEN = "sep24-session-token-must-not-leak"

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
	sellAsset:
		"stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
	price: "0.99",
	...overrides,
})

const withdrawFirst = (overrides: Record<string, unknown> = {}) => ({
	anchorTxId: "anchor_tx_1",
	urlSanitised: "https://testanchor.stellar.org/sep24/interactive",
	interactiveUrl: `https://testanchor.stellar.org/sep24/interactive?token=${HOSTED_TOKEN}`,
	kind: "withdrawal",
	...overrides,
})

const withdrawReplay = (overrides: Record<string, unknown> = {}) => ({
	anchorTxId: "anchor_tx_1",
	urlSanitised: "https://testanchor.stellar.org/sep24/interactive",
	kind: "withdrawal",
	...overrides,
})

const TERMINAL = new Set(["completed", "error", "expired", "no_market", "too_small", "too_large"])

const statusBody = (
	status: string,
	overrides: Record<string, unknown> = {},
) => ({
	anchorTxId: "anchor_tx_1",
	status,
	amountIn: "5",
	withdrawAnchorAccount:
		"GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
	withdrawMemoPresent: true,
	vaultReleaseTxRef: RELEASE_REF,
	terminal: TERMINAL.has(status),
	...overrides,
})

const FIRST = { status: 200, body: withdrawFirst() }
const REPLAY = { status: 200, body: withdrawReplay() }
const PENDING_TRANSFER = {
	status: 200,
	body: statusBody("pending_user_transfer_start"),
}

interface MockOptions {
	claim?: Record<string, unknown>
	price?: { status: number; body: unknown }
	/** Consumed in order; the last entry is reused. */
	withdraw?: Array<{ status: number; body: unknown }>
	/** Consumed in order; the last entry is reused. */
	status?: Array<{ status: number; body: unknown }>
	/** Consumed in order; the last entry is reused. */
	pay?: Array<{ status: number; body: unknown }>
	abortFirstWithdraw?: boolean
	withdrawDelayMs?: number
	payDelayMs?: number
}

async function mockAnchorApi(page: Page, options: MockOptions = {}) {
	const claim = options.claim ?? claimFixture()
	let priceCount = 0
	let withdrawCount = 0
	let statusCount = 0
	let payCount = 0
	const priceAuth: Array<string | undefined> = []
	const withdrawAuth: Array<string | undefined> = []
	const statusAuth: Array<string | undefined> = []
	const payAuth: Array<string | undefined> = []
	const withdrawKeys: string[] = []
	const withdrawBodies: unknown[] = []
	const payKeys: string[] = []
	const payBodies: unknown[] = []

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
			const queue = options.withdraw ?? [FIRST]
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
			const queue = options.status ?? [PENDING_TRANSFER]
			const next = queue[Math.min(statusCount - 1, queue.length - 1)]!
			await route.fulfill({ status: next.status, json: next.body })
		},
	)

	await page.route(
		/\/v1\/claims\/claim_anchor_1\/anchor\/withdraw\/[^/]+\/pay$/,
		async (route) => {
			if (route.request().method() !== "POST") return route.fallback()
			payCount += 1
			payAuth.push(route.request().headers()["authorization"])
			payKeys.push(route.request().headers()["idempotency-key"] ?? "")
			payBodies.push(route.request().postDataJSON())
			if (options.payDelayMs)
				await new Promise((resolve) => setTimeout(resolve, options.payDelayMs))
			const queue = options.pay ?? [
				{
					status: 200,
					body: {
						status: "submitted",
						anchorTxId: "anchor_tx_1",
						anchorPaymentTxHash: HASH_1,
					},
				},
			]
			const next = queue[Math.min(payCount - 1, queue.length - 1)]!
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
		get payCount() {
			return payCount
		},
		priceAuth,
		withdrawAuth,
		statusAuth,
		payAuth,
		withdrawKeys,
		withdrawBodies,
		payKeys,
		payBodies,
	}
}

interface WindowSpy {
	opened: string[]
	navigated: string[]
	closed: number
}

/** Records window.open and hosted navigation; the page's URL never leaves memory in prod. */
async function installWindowSpy(
	page: Page,
	options: { blockFirst?: boolean } = {},
) {
	await page.addInitScript((blockFirst: boolean) => {
		const state = { opened: [] as string[], navigated: [] as string[], closed: 0 }
		;(window as unknown as { __anchorWindow: WindowSpy }).__anchorWindow = state
		let calls = 0
		;(window as unknown as { open: (url?: string) => unknown }).open = (
			url?: string,
		) => {
			calls += 1
			state.opened.push(String(url ?? ""))
			if (blockFirst && calls === 1) return null
			return {
				opener: null,
				close() {
					state.closed += 1
				},
				location: {
					replace(next: string) {
						state.navigated.push(next)
					},
				},
			}
		}
	}, options.blockFirst ?? false)
}

const windowSpy = (page: Page): Promise<WindowSpy> =>
	page.evaluate(
		() =>
			(window as unknown as { __anchorWindow: WindowSpy }).__anchorWindow,
	)

test.use({ viewport: { width: 390, height: 844 } })

// Every test records window.open so the hosted URL stays in memory and no real tab is opened.
test.beforeEach(async ({ page }) => {
	await installWindowSpy(page)
})

test.describe("CF9 anchor option and indicative price", () => {
	test("shows the API price, requires the vault release, and keeps crypto working", async ({
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
		await expect(page.getByTestId("anchor-status")).toContainText("Not started")
		await expect(page.getByText(/^Completed$/)).toHaveCount(0)

		expect(mock.priceAuth.every((value) => value === undefined)).toBe(true)
		expect(mock.withdrawCount).toBe(0)

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

	test("a claim amount outside 1–10 USDC skips the quote but keeps the net-based withdraw", async ({
		page,
	}) => {
		const mock = await mockAnchorApi(page, {
			claim: claimFixture({
				amount: { amount: "250000000", currency: "USDC" },
			}),
		})
		await page.goto("/claim/claim_anchor_1")
		await expect(
			page.getByTestId("claim-anchor-option").getByRole("radio"),
		).toBeEnabled()
		await page.getByTestId("claim-anchor-option").getByRole("radio").check()
		await expect(page.getByTestId("anchor-quote-skipped")).toBeVisible()
		await expect(page.getByTestId("anchor-quote-skipped")).toContainText(
			/net amount/,
		)
		await expect(page.getByTestId("anchor-quote")).toHaveCount(0)
		expect(mock.priceCount).toBe(0)
	})

	test("a non-USDC claim cannot use the anchor rail", async ({ page }) => {
		await mockAnchorApi(page, {
			claim: claimFixture({
				amount: { amount: "250000", currency: "USD" },
			}),
		})
		await page.goto("/claim/claim_anchor_1")
		await expect(
			page.getByTestId("claim-anchor-option").getByRole("radio"),
		).toBeDisabled()
		await expect(page.getByTestId("claim-anchor-option")).toContainText(
			/USDC only/,
		)
	})

	test("a retryable quote failure offers a retry and no start", async ({
		page,
	}) => {
		await mockAnchorApi(page, {
			price: {
				status: 502,
				body: { code: "anchor_unavailable", message: "down" },
			},
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("claim-anchor-option").getByRole("radio").check()
		await expect(page.getByTestId("anchor-quote-error")).toContainText(
			/unavailable/i,
		)
		await expect(page.getByTestId("anchor-retry-quote")).toBeVisible()
		await expect(page.getByTestId("anchor-start")).toBeDisabled()
	})
})

test.describe("CF9 hosted screen", () => {
	test("opens the first-response interactiveUrl from memory and never shows it", async ({
		page,
	}) => {
		const consoleMessages: string[] = []
		page.on("console", (message) => consoleMessages.push(message.text()))
		const mock = await mockAnchorApi(page, { claim: acceptedClaim() })

		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()

		await expect(page.getByTestId("anchor-hosted-opened")).toBeVisible()
		const spy = await windowSpy(page)
		expect(spy.navigated).toEqual([withdrawFirst().interactiveUrl])
		expect(spy.closed).toBe(0)

		// The hosted URL is opened, never rendered.
		await expect(page.locator("body")).not.toContainText(HOSTED_TOKEN)
		await expect(page.locator("body")).not.toContainText(
			"testanchor.stellar.org/sep24/interactive?",
		)

		expect(mock.withdrawBodies[0]).toEqual({})
		expect(mock.withdrawKeys[0]).toBeTruthy()

		const stored = await page.evaluate(() => ({
			local: JSON.stringify({ ...localStorage }),
			session: JSON.stringify({ ...sessionStorage }),
		}))
		expect(stored.local).not.toContain(HOSTED_TOKEN)
		expect(stored.session).not.toContain(HOSTED_TOKEN)
		expect(stored.local).not.toContain("anchor_tx_1")
		expect(consoleMessages.join(" ")).not.toContain(HOSTED_TOKEN)
		expect(consoleMessages.join(" ")).not.toContain("claim_anchor_1")
	})

	test("a replay withdraw has no interactiveUrl and no URL is invented", async ({
		page,
	}) => {
		const mock = await mockAnchorApi(page, {
			claim: acceptedClaim(),
			withdraw: [REPLAY],
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()

		await expect(page.getByTestId("anchor-hosted-replay")).toBeVisible()
		await expect(page.getByTestId("anchor-hosted-replay")).toContainText(
			/only on the first withdrawal response/,
		)
		const spy = await windowSpy(page)
		// Only the blank placeholder was opened; it was closed, and nothing was navigated.
		expect(spy.opened).toEqual(["about:blank"])
		expect(spy.navigated).toEqual([])
		expect(spy.closed).toBe(1)
		await expect(page.getByTestId("anchor-open-hosted")).toHaveCount(0)
		expect(mock.withdrawCount).toBe(1)
	})

	test("a blocked popup leaves an explicit hosted-screen button", async ({
		page,
	}) => {
		await installWindowSpy(page, { blockFirst: true })
		await mockAnchorApi(page, { claim: acceptedClaim() })
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()

		await expect(page.getByTestId("anchor-hosted-blocked")).toBeVisible()
		await page.getByTestId("anchor-open-hosted").click()
		const spy = await windowSpy(page)
		expect(spy.opened).toContain(withdrawFirst().interactiveUrl)
		// Only from the click: one blocked placeholder, then the user action.
		expect(spy.navigated).toEqual([])
	})
})

test.describe("CF9 explicit anchor pay", () => {
	test("no pay request happens from polling or rendering", async ({ page }) => {
		const mock = await mockAnchorApi(page, {
			claim: acceptedClaim(),
			status: [
				PENDING_TRANSFER,
				{ status: 200, body: statusBody("pending_anchor") },
			],
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()
		await expect(page.getByTestId("anchor-pay")).toBeVisible()
		expect(mock.payCount).toBe(0)

		// Let the 5 s poll run once and change the status: still no pay.
		await expect(page.getByTestId("anchor-status")).toContainText("Pending", {
			timeout: 15_000,
		})
		await expect(page.getByTestId("anchor-pay")).toHaveCount(0, {
			timeout: 15_000,
		})
		expect(mock.statusCount).toBeGreaterThanOrEqual(2)
		expect(mock.payCount).toBe(0)
	})

	test("one click submits one classic payment with an empty body", async ({
		page,
	}) => {
		const mock = await mockAnchorApi(page, {
			claim: acceptedClaim({ paymentStatus: "paid" }),
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()
		await expect(page.getByTestId("anchor-pay")).toBeVisible()
		await page.getByTestId("anchor-pay").click()

		await expect(page.getByTestId("anchor-pay-submitted")).toBeVisible()
		await expect(page.getByTestId("anchor-pay-submitted")).toContainText(
			/not a completed cash-out/,
		)
		await expect(page.getByTestId("anchor-ref-payment-hash")).toContainText(HASH_1)
		await expect(page.getByTestId("anchor-status")).toContainText("Pending")
		await expect(page.getByText(/^Completed$/)).toHaveCount(0)

		expect(mock.payCount).toBe(1)
		expect(mock.payKeys[0]).toBeTruthy()
		expect(mock.payBodies[0]).toEqual({})
		expect(mock.payAuth.every((value) => value === undefined)).toBe(true)
		expect(mock.withdrawAuth.every((value) => value === undefined)).toBe(true)
		expect(mock.statusAuth.every((value) => value === undefined)).toBe(true)
	})

	test("a double click sends one pay request", async ({ page }) => {
		const mock = await mockAnchorApi(page, {
			claim: acceptedClaim(),
			payDelayMs: 300,
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()
		await expect(page.getByTestId("anchor-pay")).toBeVisible()
		await page.getByTestId("anchor-pay").evaluate((element) => {
			element.click()
			element.click()
		})
		await expect(page.getByTestId("anchor-pay-submitted")).toBeVisible()
		expect(mock.payCount).toBe(1)
		expect(mock.payKeys).toHaveLength(1)
	})

	test("202 pending reconciles with the same key and never starts a new payment", async ({
		page,
	}) => {
		const mock = await mockAnchorApi(page, {
			claim: acceptedClaim(),
			pay: [
				{
					status: 202,
					body: {
						status: "pending",
						anchorTxId: "anchor_tx_1",
						pendingTxHash: HASH_2,
					},
				},
				{
					status: 200,
					body: {
						status: "submitted",
						anchorTxId: "anchor_tx_1",
						anchorPaymentTxHash: HASH_2,
					},
				},
			],
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()
		await page.getByTestId("anchor-pay").click()

		await expect(page.getByTestId("anchor-pay-pending")).toBeVisible()
		await expect(page.getByTestId("anchor-ref-pending-hash")).toContainText(
			HASH_2,
		)
		await expect(page.getByTestId("anchor-pay-retry")).toContainText(
			/Reconcile the retained payment/,
		)
		await page.getByTestId("anchor-pay-retry").click()
		await expect(page.getByTestId("anchor-pay-submitted")).toBeVisible()

		expect(mock.payCount).toBe(2)
		expect(mock.payKeys[0]).toBe(mock.payKeys[1])
		expect(mock.payBodies[0]).toEqual(mock.payBodies[1])
	})

	test("a definitive 409 is shown and not retried with a new key", async ({
		page,
	}) => {
		const mock = await mockAnchorApi(page, {
			claim: acceptedClaim(),
			pay: [
				{
					status: 409,
					body: {
						code: "invalid_state",
						message:
							"classic payment to the anchor was rejected on-chain; do not retry",
					},
				},
			],
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()
		await page.getByTestId("anchor-pay").click()

		await expect(page.getByTestId("anchor-pay-error")).toContainText(
			/do not retry/,
		)
		await expect(page.getByTestId("anchor-pay")).toHaveCount(0)
		await expect(page.getByTestId("anchor-pay-retry")).toHaveCount(0)
		expect(mock.payCount).toBe(1)
	})

	test("a 502 pay failure retries with the same key", async ({ page }) => {
		const mock = await mockAnchorApi(page, {
			claim: acceptedClaim(),
			pay: [
				{
					status: 502,
					body: {
						code: "classic_payment_failed",
						message: "submit outcome uncertain",
					},
				},
				{
					status: 200,
					body: {
						status: "submitted",
						anchorTxId: "anchor_tx_1",
						anchorPaymentTxHash: HASH_1,
					},
				},
			],
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()
		await page.getByTestId("anchor-pay").click()
		await expect(page.getByTestId("anchor-pay-retry")).toBeVisible()
		await page.getByTestId("anchor-pay-retry").click()
		await expect(page.getByTestId("anchor-pay-submitted")).toBeVisible()
		expect(mock.payKeys[0]).toBe(mock.payKeys[1])
		expect(mock.payCount).toBe(2)
	})
})

test.describe("CF9 anchor status and refs", () => {
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
		await expect(page.getByTestId("anchor-completed")).toHaveCount(0)
	})

	test("the four refs stay separate and completed needs the anchor's successful status", async ({
		page,
	}) => {
		const stellarTx = HASH_1
		await mockAnchorApi(page, {
			claim: acceptedClaim({ paymentStatus: "paid" }),
			status: [
				{
					status: 200,
					body: statusBody("completed", {
						anchorPaymentTxHash: HASH_2,
						anchorStellarTransactionId: stellarTx,
					}),
				},
			],
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()

		await expect(page.getByTestId("anchor-ref-anchor-tx")).toContainText(
			"anchor_tx_1",
		)
		await expect(page.getByTestId("anchor-ref-releasetxref")).toContainText(
			RELEASE_REF,
		)
		await expect(page.getByTestId("anchor-ref-payment-hash")).toContainText(
			HASH_2,
		)
		await expect(page.getByTestId("anchor-ref-stellar-tx")).toContainText(
			stellarTx,
		)
		await expect(page.getByTestId("anchor-status")).toHaveAttribute(
			"data-anchor-terminal",
			"true",
		)
		await expect(page.getByTestId("anchor-completed")).toBeVisible()
		await expect(page.getByTestId("anchor-terminal-not-completed")).toHaveCount(0)
	})

	test("a terminal status that is not completed is not a success", async ({
		page,
	}) => {
		await mockAnchorApi(page, {
			claim: acceptedClaim({ paymentStatus: "paid" }),
			status: [
				{
					status: 200,
					body: statusBody("error", { anchorStellarTransactionId: HASH_1 }),
				},
			],
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()

		await expect(page.getByTestId("anchor-status")).toContainText("Failed")
		await expect(page.getByTestId("anchor-terminal-not-completed")).toBeVisible()
		await expect(page.getByText(/^Completed$/)).toHaveCount(0)
	})

	test("a terminal unknown status stays 'terminal, not completed'", async ({
		page,
	}) => {
		await mockAnchorApi(page, {
			claim: acceptedClaim(),
			status: [
				{ status: 200, body: statusBody("some_future_terminal", { terminal: true }) },
			],
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()

		await expect(page.getByTestId("anchor-status")).toContainText(
			"Terminal, not completed",
		)
		await expect(page.getByTestId("anchor-completed")).toHaveCount(0)
		await expect(page.getByText(/^Completed$/)).toHaveCount(0)
	})

	test("390 px stays inside the viewport with the anchor flow started", async ({
		page,
	}) => {
		await mockAnchorApi(page, { claim: acceptedClaim() })
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()
		await expect(page.getByTestId("anchor-pay")).toBeVisible()
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true)
	})
})

test.describe("CF9 withdraw errors", () => {
	test("an expired claim disables the option", async ({ page }) => {
		await mockAnchorApi(page, {
			claim: claimFixture({ expiresAt: now(-60_000) }),
		})
		await page.goto("/claim/claim_anchor_1")
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
	})

	test("409 invalid_state explains the missing release", async ({ page }) => {
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

	test("422 amount_out_of_range is shown as a refusal", async ({ page }) => {
		await mockAnchorApi(page, {
			claim: acceptedClaim(),
			withdraw: [
				{
					status: 422,
					body: {
						code: "amount_out_of_range",
						message: "amount must be within anchor limits",
					},
				},
			],
		})
		await page.goto("/claim/claim_anchor_1")
		await page.getByTestId("anchor-start").click()
		await expect(page.getByTestId("anchor-withdraw-error")).toContainText(
			/1 to 10 USDC/,
		)
		await expect(page.getByTestId("anchor-withdraw-started")).toHaveCount(0)
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
		await expect(page.getByTestId("anchor-withdraw-error")).toContainText(
			/same idempotency key/,
		)
		await page.getByTestId("anchor-retry").click()
		await expect(page.getByTestId("anchor-hosted-opened")).toBeVisible()

		expect(mock.withdrawCount).toBe(2)
		expect(mock.withdrawKeys[0]).toBe(mock.withdrawKeys[1])
		expect(mock.withdrawBodies[0]).toEqual({})
		expect(mock.withdrawBodies[1]).toEqual({})
	})
})

test.describe("CF9 proxy and reducer contract", () => {
	test("the local proxy forwards exactly the four anchor claim routes", () => {
		expect(
			classifyProxyRequest("POST", "/v1/claims/tok/anchor/indicative-price"),
		).toBe("claim")
		expect(classifyProxyRequest("POST", "/v1/claims/tok/anchor/withdraw")).toBe(
			"claim",
		)
		expect(
			classifyProxyRequest("GET", "/v1/claims/tok/anchor/withdraw/anchor_tx_1"),
		).toBe("claim")
		expect(
			classifyProxyRequest(
				"POST",
				"/v1/claims/tok/anchor/withdraw/anchor_tx_1/pay",
			),
		).toBe("claim")
		// Wrong verb, extra segments and other claim sub-routes stay closed.
		expect(classifyProxyRequest("GET", "/v1/claims/tok/anchor/withdraw")).toBeNull()
		expect(
			classifyProxyRequest("GET", "/v1/claims/tok/anchor/withdraw/anchor_tx_1/pay"),
		).toBeNull()
		expect(
			classifyProxyRequest(
				"POST",
				"/v1/claims/tok/anchor/withdraw/anchor_tx_1/pay/extra",
			),
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
