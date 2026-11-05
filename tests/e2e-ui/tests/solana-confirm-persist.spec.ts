import { expect, test, type Page } from "@playwright/test"
import { paymentDetailFixture } from "./fixtures"

const PAYMENT_ID = "pay_proc"
const SIGNATURE =
	"5PersistSigaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const solanaConfig = {
	cluster: "devnet",
	usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
	usdcDecimals: 6,
	explorerTxUrlTemplate:
		"https://explorer.solana.com/tx/{signature}?cluster=devnet",
	publicRpcUrl: null,
	label: "Solana USDC (devnet)",
}

const intentBody = {
	paymentId: PAYMENT_ID,
	cluster: "devnet",
	asset: "USDC",
	mint: solanaConfig.usdcMint,
	decimals: 6,
	usdcMint: solanaConfig.usdcMint,
	usdcDecimals: 6,
	amount: "12500000",
	recipient: "Recipient111111111111111111111111111111",
	reference: "Reference11111111111111111111111111111",
	intentIssuedAt: new Date().toISOString(),
	label: "Send USDC on Solana (devnet)",
	explorerTxUrlTemplate: solanaConfig.explorerTxUrlTemplate,
}

const confirmOk = {
	paymentId: PAYMENT_ID,
	paymentStatus: "paid",
	signature: SIGNATURE,
	explorerUrl: `https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet`,
	verifiedAt: new Date().toISOString(),
	cluster: "devnet",
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
				? { ...leg, status: "succeeded", releaseTxRef: SIGNATURE }
				: leg.kind === "payout"
					? { ...leg, status: "succeeded" }
					: leg,
		),
	}
}

async function mockBase(page: Page) {
	await page.route(/\/v1\/solana\/config$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ json: solanaConfig })
	})
	await page.route(
		new RegExp(`/v1/payments/${PAYMENT_ID}/solana/intent$`),
		async (route) => {
			await route.fulfill({ json: intentBody })
		},
	)
}

async function seedStoredTransfer(page: Page) {
	await page.addInitScript(
		({ paymentId, signature, sentAt }) => {
			try {
				localStorage.setItem(
					`flexipay.solana.transfer.${paymentId}`,
					JSON.stringify({ signature, sentAt }),
				)
			} catch {
				/* ignore */
			}
		},
		{
			paymentId: PAYMENT_ID,
			signature: SIGNATURE,
			sentAt: "2026-11-05T13:50:52.000Z",
		},
	)
}

test.describe("Solana confirm persistence", () => {
	test("sign button is disabled while a signature is stored", async ({
		page,
	}) => {
		await mockBase(page)
		await seedStoredTransfer(page)
		let confirms = 0
		await page.route(/\/v1\/payments\/pay_proc$/, async (route) => {
			await route.fulfill({ json: processingPayment() })
		})
		await page.route(
			new RegExp(`/v1/payments/${PAYMENT_ID}/solana/confirm$`),
			async (route) => {
				confirms += 1
				await route.fulfill({
					status: 202,
					json: { code: "pending", message: "not confirmed yet" },
				})
			},
		)

		await page.goto(`/payments/${PAYMENT_ID}`)
		await expect(page.getByTestId("solana-pay-panel")).toBeVisible()
		await expect(page.getByTestId("solana-transfer-pending")).toContainText(
			"Transfer sent at",
		)
		await expect(page.getByTestId("solana-pay-send")).toBeDisabled()
		await expect(page.getByTestId("solana-verify-transfer")).toBeVisible()
		expect(confirms).toBeGreaterThanOrEqual(1)
	})

	test("202 repeated then paid clears the stored signature", async ({
		page,
	}) => {
		await mockBase(page)
		await seedStoredTransfer(page)
		let confirms = 0
		let paid = false
		await page.route(/\/v1\/payments\/pay_proc$/, async (route) => {
			await route.fulfill({
				json: paid ? paidPayment() : processingPayment(),
			})
		})
		await page.route(
			new RegExp(`/v1/payments/${PAYMENT_ID}/solana/confirm$`),
			async (route) => {
				confirms += 1
				if (confirms < 3) {
					await route.fulfill({
						status: 202,
						json: { code: "pending", message: "not confirmed yet" },
					})
					return
				}
				paid = true
				await route.fulfill({ json: confirmOk })
			},
		)

		await page.goto(`/payments/${PAYMENT_ID}`)
		await expect(page.getByTestId("solana-transfer-pending")).toBeVisible()
		await expect(page.getByTestId("solana-pay-success")).toBeVisible({
			timeout: 20_000,
		})
		const leftover = await page.evaluate(
			(id) => localStorage.getItem(`flexipay.solana.transfer.${id}`),
			PAYMENT_ID,
		)
		expect(leftover).toBeNull()
		expect(confirms).toBeGreaterThanOrEqual(3)
	})

	test("confirm failing then succeeding after reload", async ({ page }) => {
		await mockBase(page)
		await seedStoredTransfer(page)
		let confirms = 0
		let allowConfirm = false
		let paid = false
		await page.route(/\/v1\/payments\/pay_proc$/, async (route) => {
			await route.fulfill({
				json: paid ? paidPayment() : processingPayment(),
			})
		})
		await page.route(
			new RegExp(`/v1/payments/${PAYMENT_ID}/solana/confirm$`),
			async (route) => {
				confirms += 1
				if (!allowConfirm) {
					await route.fulfill({
						status: 422,
						json: {
							code: "signature_not_found",
							message: "Signature not found on chain yet",
						},
					})
					return
				}
				paid = true
				await route.fulfill({ json: confirmOk })
			},
		)

		await page.goto(`/payments/${PAYMENT_ID}`)
		await expect(page.getByTestId("solana-pay-error")).toBeVisible({
			timeout: 10_000,
		})
		await expect(page.getByTestId("solana-pay-send")).toBeDisabled()
		await expect(page.getByTestId("solana-verify-transfer")).toBeVisible()

		const stillStored = await page.evaluate(
			(id) => localStorage.getItem(`flexipay.solana.transfer.${id}`),
			PAYMENT_ID,
		)
		expect(stillStored).toBeTruthy()
		const confirmsAfterFail = confirms
		expect(confirmsAfterFail).toBeGreaterThanOrEqual(1)

		allowConfirm = true
		await page.reload()
		await expect(page.getByTestId("solana-pay-success")).toBeVisible({
			timeout: 15_000,
		})
		expect(confirms).toBeGreaterThan(confirmsAfterFail)
	})
})
