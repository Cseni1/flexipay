import { expect, test } from "@playwright/test"
import { openTechnicalDetails, paymentDetailFixture } from "./fixtures"

const PAYMENT_ID = "pay_refund"
const REFUND_SIGNATURE =
	"5CCR37RefundSig111111111111111111111111111111111111111111"

const refundedPayment = () => {
	const base = paymentDetailFixture("failed")
	return {
		...base,
		id: PAYMENT_ID,
		status: "refunded",
		refundTxRef: REFUND_SIGNATURE,
		legs: base.legs.map((leg) =>
			leg.kind === "settle"
				? {
						...leg,
						rail: "solana_tgbp",
						providerId: "solana_tgbp",
						status: "succeeded" as const,
						externalRef: null,
						releaseTxRef: "5SettleSignature111111111111111111111111111111111",
						simulated: false,
					}
				: leg,
		),
		events: [
			...base.events,
			{
				id: "evt_refund",
				type: "payment.refunded",
				createdAt: new Date().toISOString(),
				paymentId: PAYMENT_ID,
				snapshot: { status: "refunded", refundTxRef: REFUND_SIGNATURE },
			},
		],
	}
}

test("refunded Solana payment links the confirmed refund transaction", async ({
	page,
}) => {
	await page.route(/\/v1\/solana\/config$/, async (route) => {
		await route.fulfill({
			json: {
				cluster: "devnet",
				assets: [
					{
						asset: "TGBP",
						mint: "TgbpDevMint1111111111111111111111111111111",
						decimals: 6,
					},
				],
				usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
				usdcDecimals: 6,
				explorerTxUrlTemplate:
					"https://explorer.solana.com/tx/{signature}?cluster=devnet",
				publicRpcUrl: null,
				label: "Solana TGBP (devnet)",
			},
		})
	})
	await page.route(new RegExp(`/v1/payments/${PAYMENT_ID}$`), async (route) => {
		await route.fulfill({ json: refundedPayment() })
	})

	await page.goto(`/payments/${PAYMENT_ID}`)
	await openTechnicalDetails(page)

	const link = page.getByTestId("payment-refund-link")
	await expect(link).toBeVisible()
	await expect(link).toHaveText(REFUND_SIGNATURE)
	await expect(link).toHaveAttribute(
		"href",
		`https://explorer.solana.com/tx/${REFUND_SIGNATURE}?cluster=devnet`,
	)
})
