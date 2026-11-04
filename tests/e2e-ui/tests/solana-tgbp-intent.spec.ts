import { expect, test, type Page } from "@playwright/test"
import { paymentDetailFixture } from "./fixtures"

const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
const TGBP_MINT = "TgbpDevMint1111111111111111111111111111111"

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
						rail: "solana_tgbp",
						providerId: "solana_tgbp",
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

async function mockPayment(page: Page) {
	await page.route(/\/v1\/payments\/pay_proc$/, async (route) => {
		await route.fulfill({ json: solanaSettleWaiting() })
	})
}

test.describe("Solana CCR-26 tGBP intent (mocked)", () => {
	test("TGBP intent shows £ amount and tGBP labels", async ({ page }) => {
		await page.route(/\/v1\/solana\/config$/, async (route) => {
			await route.fulfill({
				json: {
					cluster: "devnet",
					assets: [
						{ asset: "USDC", mint: USDC_MINT, decimals: 6 },
						{ asset: "TGBP", mint: TGBP_MINT, decimals: 6 },
					],
					usdcMint: USDC_MINT,
					usdcDecimals: 6,
					explorerTxUrlTemplate:
						"https://explorer.solana.com/tx/{signature}?cluster=devnet",
					publicRpcUrl: null,
					label: "Solana (devnet)",
				},
			})
		})
		await mockPayment(page)
		await page.route(
			/\/v1\/payments\/pay_proc\/solana\/intent$/,
			async (route) => {
				await route.fulfill({
					json: {
						paymentId: "pay_proc",
						cluster: "devnet",
						asset: "TGBP",
						mint: TGBP_MINT,
						decimals: 6,
						usdcMint: TGBP_MINT,
						usdcDecimals: 6,
						amount: "12500000",
						recipient: "Recipient111111111111111111111111111111",
						reference: "Reference11111111111111111111111111111",
						intentIssuedAt: new Date().toISOString(),
						label: "Send tGBP on Solana (devnet)",
						explorerTxUrlTemplate:
							"https://explorer.solana.com/tx/{signature}?cluster=devnet",
					},
				})
			},
		)

		await page.goto("/payments/pay_proc")
		await expect(page.getByTestId("solana-pay-panel")).toBeVisible()
		await expect(page.getByTestId("solana-pay-asset")).toHaveText(/£ \(tGBP\)/)
		await expect(page.getByTestId("solana-pay-amount")).toHaveText("£12.50")
		await expect(page.getByTestId("solana-pay-send")).toHaveText(
			/Sign and send tGBP \(£\)/,
		)
		await expect(page.getByText(TGBP_MINT)).toBeVisible()
	})

	test("legacy intent without asset still shows USDC", async ({ page }) => {
		await page.route(/\/v1\/solana\/config$/, async (route) => {
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
		await mockPayment(page)
		await page.route(
			/\/v1\/payments\/pay_proc\/solana\/intent$/,
			async (route) => {
				await route.fulfill({
					json: {
						paymentId: "pay_proc",
						cluster: "devnet",
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

		await page.goto("/payments/pay_proc")
		await expect(page.getByTestId("solana-pay-panel")).toBeVisible()
		await expect(page.getByTestId("solana-pay-asset")).toHaveText("USDC")
		await expect(page.getByTestId("solana-pay-amount")).toContainText("2.5")
		await expect(page.getByTestId("solana-pay-send")).toHaveText(
			/Sign and send USDC/,
		)
		await expect(page.getByText(USDC_MINT)).toBeVisible()
	})
})
