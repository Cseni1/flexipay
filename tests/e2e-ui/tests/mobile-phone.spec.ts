import { expect, test, type Page } from "@playwright/test"
import { paymentDetailFixture, paymentFromDetail } from "./fixtures"

const noSideways = async (page: Page) => {
	const metrics = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}))
	expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth)
}

const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"

const claimOpen = () => ({
	paymentId: "pay_mobile_claim",
	status: "open",
	paymentStatus: "processing",
	expiresAt: new Date(Date.now() + 120_000).toISOString(),
	amount: { amount: "250000000", currency: "USDC" },
	corridor: {
		from: { country: "US", currency: "USD" },
		to: { country: "PH", currency: "PHP" },
	},
	allowedDestinationTypes: ["crypto_wallet"],
	simulated: true,
})

const solanaSettleWaiting = () => {
	const base = paymentDetailFixture("processing")
	return {
		...base,
		id: "pay_mobile",
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
						simulated: false,
					}
				: leg,
		),
	}
}

async function mockSolanaConfig(page: Page) {
	await page.route(/\/v1\/solana\/config$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({
			json: {
				cluster: "devnet",
				usdcMint: USDC_MINT,
				usdcDecimals: 6,
				explorerTxUrlTemplate:
					"https://explorer.solana.com/tx/{signature}?cluster=devnet",
				publicRpcUrl: null,
				label: "Solana USDC (devnet)",
			},
		})
	})
}

test.describe("Phone layout 390×844", () => {
	test.use({ viewport: { width: 390, height: 844 } })

	test("claim page: no sideways scroll and Accept visible when open", async ({
		page,
	}) => {
		await page.route("**/v1/claims/demo-claim", async (route) => {
			if (route.request().method() !== "GET") return route.fallback()
			await route.fulfill({ json: claimOpen() })
		})
		await page.goto("/claim/demo-claim")
		await expect(
			page.getByRole("heading", { name: "Claim your payment" }),
		).toBeVisible()
		await noSideways(page)
		const accept = page.getByRole("button", { name: "Accept payment" })
		await expect(accept).toBeVisible()
		const box = await accept.boundingBox()
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
	})

	test("payment detail: no sideways scroll and Pay action visible", async ({
		page,
	}) => {
		await mockSolanaConfig(page)
		const detail = solanaSettleWaiting()
		await page.route(/\/v1\/payments\/pay_mobile$/, async (route) => {
			await route.fulfill({ json: detail })
		})
		await page.route(
			/\/v1\/payments\/pay_mobile\/solana\/intent$/,
			async (route) => {
				await route.fulfill({
					json: {
						paymentId: "pay_mobile",
						cluster: "devnet",
						asset: "USDC",
						mint: USDC_MINT,
						decimals: 6,
						usdcMint: USDC_MINT,
						usdcDecimals: 6,
						amount: "2500000",
						recipient: "Recipient111111111111111111111111111111",
						reference: "Reference11111111111111111111111111111",
						intentIssuedAt: new Date().toISOString(),
						label: "Send USDC on Solana (devnet)",
						explorerTxUrlTemplate:
							"https://explorer.solana.com/tx/{signature}?cluster=devnet",
					},
				})
			},
		)
		await page.goto("/payments/pay_mobile")
		await expect(
			page.getByRole("heading", { name: "Payment detail" }),
		).toBeVisible()
		await noSideways(page)
		const pay = page.getByTestId("solana-pay-send")
		await expect(pay).toBeVisible()
		const box = await pay.boundingBox()
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
		const fullWidth = await pay.evaluate((el) => {
			const button = el.getBoundingClientRect().width
			const parent = el.parentElement?.getBoundingClientRect().width ?? 0
			return parent > 0 && button / parent >= 0.95
		})
		expect(fullWidth).toBe(true)
	})

	test("payments list: stacked cards, no sideways scroll", async ({ page }) => {
		const detail = paymentDetailFixture("awaiting_funding")
		const list = { payments: [paymentFromDetail(detail)] }
		await page.route(/\/v1\/payments(\?|$)/, async (route) => {
			if (route.request().method() !== "GET") return route.fallback()
			await route.fulfill({ json: list })
		})
		await page.goto("/payments")
		await expect(page.getByRole("heading", { name: "Payments" })).toBeVisible()
		await expect(page.getByTestId("payment-history-cards")).toBeVisible()
		await expect(page.getByTestId("payment-history")).toBeHidden()
		await noSideways(page)
		await expect(
			page.getByTestId("payment-history-cards").getByRole("link").first(),
		).toBeVisible()
	})

	test("dashboard: no sideways scroll and New payment visible", async ({
		page,
	}) => {
		const detail = paymentDetailFixture("awaiting_funding")
		await page.route(/\/v1\/payments(\?|$)/, async (route) => {
			if (route.request().method() !== "GET") return route.fallback()
			await route.fulfill({
				json: { payments: [paymentFromDetail(detail)] },
			})
		})
		await page.goto("/dashboard")
		await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible()
		await noSideways(page)
		const cta = page
			.getByRole("main")
			.getByRole("link", { name: "New payment" })
		await expect(cta).toBeVisible()
		const box = await cta.boundingBox()
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
		await expect(page.getByTestId("payment-history-cards")).toBeVisible()
	})
})
