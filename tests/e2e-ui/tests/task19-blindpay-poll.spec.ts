import { expect, test, type Page } from "@playwright/test"
import { paymentDetailFixture } from "./fixtures"

const processingBlindPay = () => {
	const base = paymentDetailFixture("processing")
	return {
		...base,
		id: "pay_blindpay",
		status: "processing",
		legs: base.legs.map((leg) =>
			leg.kind === "payout"
				? {
						...leg,
						rail: "blindpay_sandbox",
						providerId: "blindpay_sandbox",
						status: "processing",
						simulated: true,
					}
				: leg.kind === "settle"
					? {
							...leg,
							status: "succeeded",
							simulated: false,
						}
					: leg,
		),
	}
}

const paidBlindPay = () => {
	const base = processingBlindPay()
	return {
		...base,
		status: "paid",
		legs: base.legs.map((leg) =>
			leg.kind === "payout" ? { ...leg, status: "succeeded" } : leg,
		),
		events: [
			...base.events,
			{
				id: "evt_paid",
				type: "payment.paid",
				createdAt: new Date().toISOString(),
				paymentId: "pay_blindpay",
				snapshot: { status: "paid" },
			},
		],
	}
}

async function mockBlindPayPoll(page: Page) {
	const state = { gets: 0, paidAfter: Number.POSITIVE_INFINITY }
	await page.route(/\/v1\/payments\/pay_blindpay$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		state.gets += 1
		await route.fulfill({
			json:
				state.gets >= state.paidAfter ? paidBlindPay() : processingBlindPay(),
		})
	})
	await page.route(/\/v1\/solana\/config$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({
			json: {
				cluster: "devnet",
				usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
				usdcDecimals: 6,
				explorerTxUrlTemplate:
					"https://explorer.solana.com/tx/{signature}?cluster=devnet",
				publicRpcUrl: null,
				label: "Solana USDC (devnet)",
			},
		})
	})
	return state
}

test.describe("TASK 19 BlindPay payout polling", () => {
	test("shows Waiting for BlindPay then Paid after two polls", async ({
		page,
	}) => {
		await page.clock.install()
		const state = await mockBlindPayPoll(page)
		await page.goto("/payments/pay_blindpay")

		await expect(page.getByTestId("leg-waiting-payout")).toBeVisible()
		await expect(page.getByTestId("leg-waiting-payout")).toHaveText(
			"Waiting for BlindPay",
		)
		await expect(page.getByTestId("leg-polling-note").first()).toHaveText(
			"Checking every 10 s",
		)
		await expect(
			page.getByTestId("payment-leg-payout").getByText("Sandbox", {
				exact: true,
			}),
		).toBeVisible()

		// React Strict Mode may fetch twice on mount; pay on the 2nd poll after load.
		const afterLoad = state.gets
		expect(afterLoad).toBeGreaterThanOrEqual(1)
		state.paidAfter = afterLoad + 2

		await page.clock.runFor(10_000)
		await expect.poll(() => state.gets).toBeGreaterThanOrEqual(afterLoad + 1)

		await page.clock.runFor(10_000)
		await expect.poll(() => state.gets).toBeGreaterThanOrEqual(afterLoad + 2)

		await expect(page.getByTestId("leg-waiting-payout")).toHaveCount(0)
		await expect(
			page.getByTestId("payment-leg-payout").getByText("Succeeded", {
				exact: true,
			}),
		).toBeVisible()
		await expect(
			page
				.locator(".status-badge")
				.filter({ hasText: /^Paid$/i })
				.first(),
		).toBeVisible()
	})

	test("390px: waiting BlindPay state does not scroll sideways", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 })
		await mockBlindPayPoll(page)
		await page.goto("/payments/pay_blindpay")
		await expect(page.getByTestId("leg-waiting-payout")).toBeVisible()
		const metrics = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			innerWidth: window.innerWidth,
		}))
		expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth)
	})
})
