import { expect, test, type Page } from "@playwright/test"
import { paymentDetailFixture } from "./fixtures"

const signature =
	"5VEJv1FxuheTA9HyYFuH6AqR3oMeG8z5g8K5m9n0p1q2r3s4t5u6v7w8x9y0z1a2b"

const solanaConfig = {
	cluster: "devnet",
	usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
	usdcDecimals: 6,
	explorerTxUrlTemplate:
		"https://explorer.solana.com/tx/{signature}?cluster=devnet",
	publicRpcUrl: null,
	label: "Solana USDC (devnet)",
}

async function mockSolanaConfig(page: Page) {
	await page.route(/\/v1\/solana\/config$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ json: solanaConfig })
	})
}

const solanaPaid = () => {
	const base = paymentDetailFixture("processing")
	return {
		...base,
		id: "pay_paid",
		organizationId: "org_ABCDEFGHijklmnop",
		recipientId: "rcp_1234567890abcdef",
		status: "paid",
		legs: base.legs.map((leg) =>
			leg.kind === "settle"
				? {
						...leg,
						rail: "solana_usdc",
						providerId: "solana_usdc",
						status: "succeeded",
						releaseTxRef: signature,
					}
				: leg.kind === "payout"
					? { ...leg, status: "succeeded" }
					: leg,
		),
	}
}

test.describe("Resilience: API wake-up", () => {
	test("shows waking-up copy on 503 and retries without raw JSON", async ({
		page,
	}) => {
		// Stay down until the tester clicks Retry (Strict Mode remounts must not "succeed").
		let allowSuccess = false
		await page.route(/\/v1\/payments\/pay_asleep$/, async (route) => {
			if (!allowSuccess) {
				await route.fulfill({
					status: 503,
					json: {
						code: "internal_error",
						message: '{"stack":"Render cold start"}',
					},
				})
				return
			}
			await route.fulfill({
				json: {
					...paymentDetailFixture("awaiting_funding"),
					id: "pay_asleep",
				},
			})
		})
		await page.goto("/payments/pay_asleep")
		const wake = page.getByTestId("api-wakeup")
		await expect(wake).toBeVisible()
		await expect(wake).toContainText("Waking up the server")
		await expect(wake).toContainText("up to a minute")
		await expect(wake).not.toContainText("{")
		await expect(wake).not.toContainText("stack")
		allowSuccess = true
		await Promise.all([
			page.waitForResponse(
				(response) =>
					response.url().includes("/v1/payments/pay_asleep") && response.ok(),
			),
			page.getByTestId("api-wakeup-retry").click(),
		])
		await expect(page.getByTestId("api-wakeup")).toHaveCount(0)
		const summary = page.getByTestId("payment-summary")
		await expect(summary).toBeVisible()
		await expect(page.getByTestId("payment-summary-send")).toHaveText(
			"1,250.00 USD",
		)
	})

	test("replaces waking copy after automatic retries are exhausted", async ({
		page,
	}) => {
		await page.clock.install()
		await page.route(/\/v1\/payments\/pay_exhausted$/, async (route) => {
			await route.fulfill({
				status: 503,
				json: {
					code: "internal_error",
					message: '{"stack":"still down"}',
				},
			})
		})
		await page.goto("/payments/pay_exhausted")
		const wake = page.getByTestId("api-wakeup")
		await expect(wake).toBeVisible()
		await expect(wake).toContainText("Waking up the server")
		// Six scheduled delays: 3+5+8+12+15+17s. Advance the fake clock, then
		// wait for the exhausted UI (not a fixed wall-clock sleep).
		for (let i = 0; i < 6; i += 1) {
			await page.clock.runFor(20_000)
		}
		await expect(wake).toHaveAttribute("data-exhausted", "true")
		await expect(wake).toContainText("Something went wrong on our side")
		await expect(wake).toContainText("contact support")
		await expect(wake).not.toContainText("Waking up the server")
		await expect(wake).not.toContainText("{")
		await expect(page.getByTestId("api-wakeup-retry")).toBeVisible()
	})
})

test.describe("Receipt: paid Solana payment", () => {
	test("shows amount, shortened parties, status, signature and explorer", async ({
		page,
		context,
		baseURL,
	}) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"], {
			origin: new URL(baseURL ?? "http://localhost").origin,
		})
		await mockSolanaConfig(page)
		await page.route(/\/v1\/payments\/pay_paid$/, async (route) => {
			await route.fulfill({ json: solanaPaid() })
		})
		await page.goto("/payments/pay_paid")

		const receipt = page.getByTestId("payment-receipt")
		await expect(receipt).toBeVisible()
		await expect(page.getByTestId("payment-receipt-amount")).toContainText(
			"USD",
		)
		await expect(page.getByTestId("payment-receipt-sender")).toContainText("…")
		await expect(page.getByTestId("payment-receipt-receiver")).toContainText(
			"…",
		)
		await expect(page.getByTestId("payment-receipt-status")).toHaveText("paid")
		await expect(page.getByTestId("solana-pay-success")).toBeVisible()
		await expect(page.getByTestId("solana-tx-signature")).toHaveText(signature)
		const explorer = page.getByTestId("payment-explorer-link")
		await expect(explorer).toHaveText("View on Solana Explorer")
		await expect(explorer).toHaveAttribute(
			"href",
			`https://explorer.solana.com/tx/${signature}?cluster=devnet`,
		)
		const copy = page.getByRole("button", {
			name: "Copy signature",
			exact: true,
		})
		await expect(copy).toBeVisible()
		await copy.click()
		await expect(
			page.getByRole("status").filter({ hasText: "Copied" }),
		).toBeVisible()
		await expect(page.getByTestId("payment-receipt-print")).toBeVisible()
	})

	test("receipt remains usable at 390px", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 })
		await mockSolanaConfig(page)
		await page.route(/\/v1\/payments\/pay_paid$/, async (route) => {
			await route.fulfill({ json: solanaPaid() })
		})
		await page.goto("/payments/pay_paid")
		await expect(page.getByTestId("payment-receipt")).toBeVisible()
		const overflow = await page.evaluate(
			() =>
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth + 1,
		)
		expect(overflow).toBe(false)
	})
})
