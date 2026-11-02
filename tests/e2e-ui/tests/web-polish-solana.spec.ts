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

const solanaSettleWaiting = () => {
	const base = paymentDetailFixture("processing")
	return {
		...base,
		id: "pay_proc",
		status: "processing",
		legs: base.legs.map((leg) =>
			leg.kind === "settle"
				? {
						...leg,
						rail: "solana_usdc",
						providerId: "solana_usdc",
						status: "processing",
						externalRef: null,
						lockTxRef: null,
						releaseTxRef: null,
					}
				: leg,
		),
	}
}

const solanaPaid = () => {
	const base = solanaSettleWaiting()
	return {
		...base,
		id: "pay_paid",
		status: "paid",
		legs: base.legs.map((leg) =>
			leg.kind === "settle"
				? {
						...leg,
						status: "succeeded",
						releaseTxRef: signature,
					}
				: leg.kind === "payout"
					? { ...leg, status: "succeeded" }
					: leg,
		),
	}
}

test.describe("Web polish: Solana pay messaging", () => {
	test("paid payment shows signature, explorer link and copy", async ({
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
		await expect(page.getByTestId("solana-pay-success")).toBeVisible()
		await expect(page.getByTestId("solana-tx-signature")).toHaveText(signature)
		const explorer = page.getByTestId("payment-explorer-link")
		await expect(explorer).toHaveText("View on Solana Explorer")
		await expect(explorer).toHaveAttribute(
			"href",
			`https://explorer.solana.com/tx/${signature}?cluster=devnet`,
		)
		await page.getByRole("button", { name: "Copy signature" }).click()
		await expect(
			page.getByRole("status").filter({ hasText: "Copied" }),
		).toBeVisible()
		const text = await page.evaluate(() => navigator.clipboard.readText())
		expect(text).toBe(signature)
	})

	test("Solana intent 500 shows the prepare-failed message, not JSON", async ({
		page,
	}) => {
		await mockSolanaConfig(page)
		await page.route(/\/v1\/payments\/pay_proc$/, async (route) => {
			await route.fulfill({ json: solanaSettleWaiting() })
		})
		await page.route(
			/\/v1\/payments\/pay_proc\/solana\/intent$/,
			async (route) => {
				await route.fulfill({
					status: 500,
					json: { code: "internal_error", message: '{"raw":"stack"}' },
				})
			},
		)
		await page.goto("/payments/pay_proc")
		const error = page.getByTestId("solana-pay-error")
		await expect(error).toBeVisible()
		await expect(error).toContainText(
			"Payment could not be prepared. Try again or contact support.",
		)
		await expect(error).not.toContainText("{")
	})
})

test.describe("Web polish: mobile 390px", () => {
	test("Send, Payment detail and Claim fit without horizontal scroll", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 })
		await page.goto("/")
		await expect(
			page.getByRole("heading", { name: "Send a payment" }),
		).toBeVisible()
		const sendScroll = await page.evaluate(
			() =>
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth + 1,
		)
		expect(sendScroll).toBe(false)

		await page.route(/\/v1\/payments\/demo-payment$/, (route) =>
			route.fulfill({
				json: paymentDetailFixture("awaiting_funding"),
			}),
		)
		await mockSolanaConfig(page)
		await page.goto("/payments/demo-payment")
		await expect(
			page.getByRole("heading", { name: "Payment detail" }),
		).toBeVisible()
		const detailScroll = await page.evaluate(
			() =>
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth + 1,
		)
		expect(detailScroll).toBe(false)

		const buttonHeight = await page
			.getByRole("button", { name: "Refresh" })
			.evaluate((el) => el.getBoundingClientRect().height)
		expect(buttonHeight).toBeGreaterThanOrEqual(44)

		await page.route("**/v1/claims/demo-claim", (route) =>
			route.fulfill({
				status: 404,
				json: {
					code: "not_found",
					message: "This claim link is invalid or no longer exists.",
				},
			}),
		)
		await page.goto("/claim/demo-claim")
		await expect(
			page.getByRole("heading", { name: "Claim your payment" }),
		).toBeVisible()
		const claimScroll = await page.evaluate(
			() =>
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth + 1,
		)
		expect(claimScroll).toBe(false)
	})
})
