import { expect, test, type Page } from "@playwright/test"
import { paymentDetailFixture, quoteFixture } from "./fixtures"

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

const MAINNET_CONFIG = {
	cluster: "mainnet-beta",
	assets: [{ asset: "USDC", mint: USDC_MINT, decimals: 6 }],
	usdcMint: USDC_MINT,
	usdcDecimals: 6,
	explorerTxUrlTemplate: "https://explorer.solana.com/tx/{signature}",
	publicRpcUrl: null,
	label: "Solana USDC",
}

function waitingPayment() {
	const base = paymentDetailFixture("processing")
	return {
		...base,
		id: "pay_live",
		quoteId: "quo_1",
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

async function mockMainnet(page: Page) {
	await page.route(/\/v1\/solana\/config$/, async (route) => {
		await route.fulfill({ json: MAINNET_CONFIG })
	})
	await page.route(/\/v1\/corridors$/, async (route) => {
		await route.fulfill({
			json: {
				corridors: [
					{
						from: { country: "US", currency: "USD" },
						to: { country: "PH", currency: "PHP" },
						allowedDestinationTypes: ["bank_account"],
						recipientKinds: ["individual"],
						regulationNote: "Fixture.",
						simulated: true,
						legsAvailable: {
							collect: ["sim_bank_us_ach"],
							convert: ["sim_fx"],
							settle: ["solana_usdc"],
							payout: ["tazapay_sandbox"],
						},
					},
				],
			},
		})
	})
}

test.describe("TASK 31 live mode", () => {
	test("mainnet shows Live money, hides sandbox partners, and confirms before signing", async ({
		page,
	}) => {
		await mockMainnet(page)
		await page.route(/\/v1\/payments\/pay_live$/, async (route) => {
			await route.fulfill({ json: waitingPayment() })
		})
		await page.route(/\/v1\/quotes\/quo_1$/, async (route) => {
			const quote = quoteFixture()
			quote.route = quote.route.map((leg) =>
				leg.kind === "payout"
					? { ...leg, providerId: "tazapay_sandbox", rail: "tazapay_sandbox" }
					: leg,
			)
			await route.fulfill({ json: quote })
		})
		await page.route(
			/\/v1\/payments\/pay_live\/solana\/intent$/,
			async (route) => {
				await route.fulfill({
					json: {
						paymentId: "pay_live",
						cluster: "mainnet-beta",
						asset: "USDC",
						mint: USDC_MINT,
						decimals: 6,
						usdcMint: USDC_MINT,
						usdcDecimals: 6,
						amount: "1000000",
						recipient: "Recipient111111111111111111111111111111",
						reference: "Reference11111111111111111111111111111",
						intentIssuedAt: new Date().toISOString(),
						label: "Send USDC on Solana",
						explorerTxUrlTemplate: "https://explorer.solana.com/tx/{signature}",
					},
				})
			},
		)

		await page.goto("/where-we-pay")
		await expect(page.getByTestId("mode-banner")).toHaveAttribute(
			"data-mode",
			"live",
		)
		await expect(page.getByTestId("mode-banner")).toContainText("Live money")
		await expect(page.getByTestId("live-coverage")).toBeVisible()
		await expect(page.getByTestId("sandbox-priced")).toHaveCount(0)
		await expect(page.getByText("Priced live in sandbox")).toHaveCount(0)

		await page.goto("/payments/pay_live")
		const confirm = page.getByTestId("live-sign-confirm")
		await expect(confirm).toBeVisible()
		await expect(page.getByTestId("live-confirm-amount")).not.toHaveText(
			/Loading/,
		)
		await expect(page.getByTestId("live-confirm-fees")).not.toHaveText("—")
		await expect(page.getByTestId("live-confirm-receive")).toContainText("PHP")
		await expect(page.getByTestId("live-confirm-partner")).toHaveText("Tazapay")
		await expect(page.getByTestId("solana-pay-send")).toHaveAttribute(
			"data-sign-locked",
			"true",
		)
		await page.getByTestId("live-confirm-sign").click()
		await expect(page.getByTestId("solana-pay-send")).toHaveAttribute(
			"data-sign-locked",
			"false",
		)
	})

	test("without mainnet config the banner stays in test mode", async ({
		page,
	}) => {
		await page.route(/\/v1\/solana\/config$/, async (route) => {
			await route.fulfill({ status: 404, json: { code: "not_found" } })
		})
		await page.goto("/")
		await expect(page.getByTestId("mode-banner")).toHaveAttribute(
			"data-mode",
			"test",
		)
		await expect(page.getByTestId("mode-banner")).toContainText("Test mode")
	})
})
