import { expect, test, type Page } from "@playwright/test"
import { paymentDetailFixture } from "./fixtures"

const PAYMENT_ID = "pay_flexi"
const STUB_SIGNATURE =
	"5FexiPayStubSigaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
/** Valid base58 Solana pubkeys (buildUsdcTransferTransaction requires real keys). */
const TGBP_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
const RECIPIENT = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
const REFERENCE = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"

const solanaConfig = {
	cluster: "devnet",
	assets: [
		{ asset: "USDC", mint: USDC_MINT, decimals: 6 },
		{ asset: "TGBP", mint: TGBP_MINT, decimals: 6 },
	],
	usdcMint: USDC_MINT,
	usdcDecimals: 6,
	explorerTxUrlTemplate:
		"https://explorer.solana.com/tx/{signature}?cluster=devnet",
	publicRpcUrl: "https://api.devnet.solana.com",
	label: "Solana (devnet)",
}

const processingPayment = () => {
	const base = paymentDetailFixture("processing")
	return {
		...base,
		id: PAYMENT_ID,
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

const paidPayment = () => {
	const base = processingPayment()
	return {
		...base,
		status: "paid",
		events: [
			...base.events,
			{
				id: "evt_paid",
				type: "payment.paid",
				createdAt: new Date().toISOString(),
				paymentId: PAYMENT_ID,
				snapshot: { status: "paid" },
			},
		],
		legs: base.legs.map((leg) =>
			leg.kind === "settle"
				? { ...leg, status: "succeeded", releaseTxRef: STUB_SIGNATURE }
				: leg.kind === "payout"
					? { ...leg, status: "succeeded" }
					: leg,
		),
	}
}

async function mockSolanaRpc(page: Page) {
	await page.route(/https:\/\/api\.devnet\.solana\.com\/?/, async (route) => {
		const raw = route.request().postData() ?? "{}"
		let body: { method?: string; id?: number } = {}
		try {
			body = JSON.parse(raw) as { method?: string; id?: number }
		} catch {
			body = {}
		}
		const id = body.id ?? 1
		const method = body.method
		if (method === "getBalance") {
			await route.fulfill({
				json: {
					jsonrpc: "2.0",
					id,
					result: { context: { slot: 1 }, value: 2_000_000_000 },
				},
			})
			return
		}
		if (method === "getTokenAccountBalance") {
			await route.fulfill({
				json: {
					jsonrpc: "2.0",
					id,
					result: {
						context: { slot: 1 },
						value: {
							amount: "999000000",
							decimals: 6,
							uiAmount: 999,
							uiAmountString: "999",
						},
					},
				},
			})
			return
		}
		if (method === "getLatestBlockhash" || method === "getRecentBlockhash") {
			await route.fulfill({
				json: {
					jsonrpc: "2.0",
					id,
					result: {
						context: { slot: 1 },
						value: {
							blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
							lastValidBlockHeight: 999_999,
						},
					},
				},
			})
			return
		}
		if (method === "getAccountInfo" || method === "getMultipleAccounts") {
			await route.fulfill({
				json: {
					jsonrpc: "2.0",
					id,
					result: { context: { slot: 1 }, value: null },
				},
			})
			return
		}
		await route.fulfill({
			json: { jsonrpc: "2.0", id, result: null },
		})
	})
}

test.describe("FlexiPay wallet pays Solana settle", () => {
	test("signed-in stub wallet confirms a TGBP intent", async ({ page }) => {
		let confirmSignature: string | null = null
		let paid = false

		await mockSolanaRpc(page)
		await page.route(/\/v1\/solana\/config$/, async (route) => {
			await route.fulfill({ json: solanaConfig })
		})
		await page.route(new RegExp(`/v1/payments/${PAYMENT_ID}$`), async (route) => {
			await route.fulfill({
				json: paid ? paidPayment() : processingPayment(),
			})
		})
		await page.route(
			new RegExp(`/v1/payments/${PAYMENT_ID}/solana/intent$`),
			async (route) => {
				await route.fulfill({
					json: {
						paymentId: PAYMENT_ID,
						cluster: "devnet",
						asset: "TGBP",
						mint: TGBP_MINT,
						decimals: 6,
						usdcMint: TGBP_MINT,
						usdcDecimals: 6,
						amount: "12500000",
						recipient: RECIPIENT,
						reference: REFERENCE,
						intentIssuedAt: new Date().toISOString(),
						label: "Send tGBP on Solana (devnet)",
						explorerTxUrlTemplate: solanaConfig.explorerTxUrlTemplate,
					},
				})
			},
		)
		await page.route(
			new RegExp(`/v1/payments/${PAYMENT_ID}/solana/confirm$`),
			async (route) => {
				const body = route.request().postDataJSON() as { signature?: string }
				confirmSignature = body.signature ?? null
				paid = true
				await route.fulfill({
					json: {
						paymentId: PAYMENT_ID,
						paymentStatus: "paid",
						signature: STUB_SIGNATURE,
						explorerUrl: `https://explorer.solana.com/tx/${STUB_SIGNATURE}?cluster=devnet`,
						verifiedAt: new Date().toISOString(),
						cluster: "devnet",
					},
				})
			},
		)

		await page.goto("/pay-from")
		await page.getByTestId("flexipay-wallet-open").click()
		await expect(page.getByTestId("flexipay-wallet-ready")).toBeVisible()
		await expect(page.getByTestId("flexipay-wallet-receive")).toBeVisible()
		await expect(page.getByTestId("flexipay-wallet-sol")).toContainText("0.1")

		await page.goto(`/payments/${PAYMENT_ID}`)
		await expect(page.getByTestId("solana-pay-panel")).toBeVisible()
		await expect(page.getByTestId("solana-pay-asset")).toHaveText(/£ \(tGBP\)/)
		const flexiPay = page.getByTestId("solana-pay-flexipay")
		await expect(flexiPay).toBeVisible()
		await flexiPay.click()

		await expect(page.getByTestId("solana-pay-success")).toBeVisible({
			timeout: 15_000,
		})
		expect(confirmSignature).toBe(STUB_SIGNATURE)
	})
})
