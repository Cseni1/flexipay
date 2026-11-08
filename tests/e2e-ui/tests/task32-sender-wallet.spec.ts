import { expect, test, type Page } from "@playwright/test"
import {
	Keypair,
	SystemProgram,
	TransactionMessage,
	VersionedTransaction,
} from "@solana/web3.js"
import { paymentDetailFixture } from "./fixtures"

const delegationTx = (() => {
	const payer = Keypair.generate()
	const message = new TransactionMessage({
		payerKey: payer.publicKey,
		recentBlockhash: "11111111111111111111111111111111",
		instructions: [
			SystemProgram.transfer({
				fromPubkey: payer.publicKey,
				toPubkey: payer.publicKey,
				lamports: 0,
			}),
		],
	}).compileToV0Message()
	return Buffer.from(new VersionedTransaction(message).serialize()).toString(
		"base64",
	)
})()

function senderPayment(phase: "approve" | "tracking" | "returned") {
	const base = paymentDetailFixture(
		phase === "approve" ? "awaiting_funding" : "processing",
	)
	const settle = {
		...base.legs[2]!,
		kind: "settle" as const,
		rail: "sender_wallet_blindpay",
		providerId: "blindpay_sandbox",
		status: phase === "approve" ? "pending" : "succeeded",
		externalRef: null,
		lockTxRef: null,
		releaseTxRef: phase === "approve" ? null : "sig",
	}
	const payout = {
		...base.legs[4]!,
		kind: "payout" as const,
		rail: "blindpay_sandbox",
		providerId: "blindpay_sandbox",
		status: phase === "returned" ? "failed" : phase === "tracking" ? "processing" : "pending",
		externalRef: phase === "approve" ? null : "pa_sol",
		error:
			phase === "returned"
				? { code: "returned_to_wallet", message: "returned to your wallet" }
				: null,
	}
	return {
		...base,
		id: "pay_sender",
		status: phase === "returned" ? "refunded" : phase === "tracking" ? "processing" : "awaiting_funding",
		legs: [settle, payout],
		events: base.events.map((event) => ({ ...event, paymentId: "pay_sender" })),
	}
}

async function installWallet(page: Page, chains: string[] = ["solana:devnet"]) {
	await page.addInitScript((chains: string[]) => {
		let sent = 0
		const account = {
			address: "11111111111111111111111111111111",
			publicKey: new Uint8Array(32),
			chains,
			features: ["solana:signAndSendTransaction"],
		}
		const wallet = {
			version: "1.0.0",
			name: "Phantom",
			icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
			chains,
			accounts: [] as typeof account[],
			features: {
				"standard:connect": {
					version: "1.0.0",
					connect: async () => {
						wallet.accounts = [account]
						return { accounts: [account] }
					},
				},
				"standard:disconnect": {
					version: "1.0.0",
					disconnect: async () => {
						wallet.accounts = []
					},
				},
				"standard:events": {
					version: "1.0.0",
					on: () => () => {},
				},
				"solana:signAndSendTransaction": {
					version: "1.0.0",
					supportedTransactionVersions: ["legacy", 0],
					signAndSendTransaction: async () => {
						const signature = new Uint8Array(64)
						sent += 1
						signature[0] = 9
						signature[1] = sent
						;(window as unknown as { __signed: number }).__signed = sent
						return [{ signature }]
					},
				},
			},
		}
		window.addEventListener("wallet-standard:app-ready", (event) => {
			const ready = event as CustomEvent<{
				register: (next: typeof wallet) => void
			}>
			ready.detail.register(wallet)
		})
	}, chains)
}

test("sender wallet: confirm, approve, then track", async ({ page }) => {
	let phase: "approve" | "tracking" = "approve"
	await installWallet(page)
	await page.route(/\/v1\/solana\/config$/, async (route) => {
		await route.fulfill({
			json: {
				cluster: "devnet",
				usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
				usdcDecimals: 6,
				explorerTxUrlTemplate:
					"https://explorer.solana.com/tx/{signature}?cluster=devnet",
				label: "Solana USDC (devnet)",
			},
		})
	})
	await page.route(/\/v1\/payments\/pay_sender$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ json: senderPayment(phase) })
	})
	await page.route(/\/v1\/payments\/pay_sender\/blindpay\/delegation$/, async (route) => {
		await route.fulfill({
			json: {
				transaction: delegationTx,
				quoteId: "qu_blind",
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
				ownerAddress: "11111111111111111111111111111111",
			},
		})
	})
	await page.route(/\/v1\/payments\/pay_sender\/blindpay\/confirm$/, async (route) => {
		phase = "tracking"
		await route.fulfill({
			json: { status: "accepted", payoutId: "pa_sol", paymentStatus: "processing" },
		})
	})
	await page.goto("/payments/pay_sender")
	await page.getByTestId("solana-wallet-connect").click()
	await page.getByTestId("blindpay-confirm").check()
	await expect(page.getByTestId("blindpay-approve")).toBeEnabled()
	await page.getByTestId("blindpay-approve").click()
	await expect(page.getByTestId("blindpay-tracking")).toBeVisible()
})

test("a refunded sender-wallet payout says returned to your wallet", async ({ page }) => {
	await page.route(/\/v1\/solana\/config$/, async (route) => {
		await route.fulfill({
			json: {
				cluster: "devnet",
				usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
				usdcDecimals: 6,
				label: "Solana USDC (devnet)",
			},
		})
	})
	await page.route(/\/v1\/payments\/pay_sender$/, async (route) => {
		await route.fulfill({ json: senderPayment("returned") })
	})
	await page.goto("/payments/pay_sender")
	await expect(page.getByTestId("blindpay-returned")).toHaveText(
		"returned to your wallet",
	)
})

test("CCR-49: on mainnet a tGBP sender swaps via Jupiter, then approves the payout", async ({ page }) => {
	let phase: "approve" | "tracking" = "approve"
	const order: string[] = []
	let confirms = 0
	await installWallet(page, ["solana:mainnet"])
	await page.route(/\/v1\/solana\/config$/, async (route) => {
		await route.fulfill({
			json: {
				cluster: "mainnet-beta",
				usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
				usdcDecimals: 6,
				explorerTxUrlTemplate: "https://explorer.solana.com/tx/{signature}",
				label: "Solana USDC",
				swapInputAssets: ["TGBP"],
			},
		})
	})
	await page.route(/\/v1\/payments\/pay_sender$/, async (route) => {
		if (route.request().method() !== "GET") return route.fallback()
		await route.fulfill({ json: senderPayment(phase) })
	})
	await page.route(/\/v1\/payments\/pay_sender\/solana-swap$/, async (route) => {
		order.push("swap")
		await route.fulfill({
			json: {
				status: "ready",
				provider: "jupiter",
				transaction: delegationTx,
				inputAsset: "TGBP",
				inputMint: "2zMqyX4AYCk6mgy5UZ2S7zUaLxwERhK5WjqDzkPPbSpW",
				inputDecimals: 9,
				inputAmount: "74700000000",
				inputMaxAmount: "75073500000",
				outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
				outputDecimals: 6,
				outputAmount: "100000000",
				requiredAmount: "100000000",
				heldAmount: "0",
				slippageBps: 50,
				priceImpact: 0.0001,
				route: ["Whirlpool"],
			},
		})
	})
	await page.route(/\/v1\/payments\/pay_sender\/solana-swap\/confirm$/, async (route) => {
		confirms += 1
		order.push(`swap-confirm-${confirms}`)
		await route.fulfill({
			json: {
				status: confirms === 1 ? "pending" : "confirmed",
				signature: "5".repeat(88),
				heldAmount: confirms === 1 ? "0" : "100000000",
				requiredAmount: "100000000",
			},
		})
	})
	await page.route(/\/v1\/payments\/pay_sender\/blindpay\/delegation$/, async (route) => {
		order.push("delegation")
		await route.fulfill({
			json: {
				transaction: delegationTx,
				quoteId: "qu_blind",
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
				ownerAddress: "11111111111111111111111111111111",
			},
		})
	})
	await page.route(/\/v1\/payments\/pay_sender\/blindpay\/confirm$/, async (route) => {
		order.push("confirm")
		phase = "tracking"
		await route.fulfill({
			json: { status: "accepted", payoutId: "pa_sol", paymentStatus: "processing" },
		})
	})
	await page.goto("/payments/pay_sender")
	await page.getByTestId("solana-wallet-connect").click()
	await page.getByTestId("blindpay-pay-tgbp").check()
	await expect(page.getByTestId("blindpay-swap-preview")).toContainText(
		"Swap about 74.70 tGBP (at most 75.07) for 100.00 USDC",
	)
	await page.getByTestId("blindpay-confirm").check()
	await page.getByTestId("blindpay-approve").click()
	await expect(page.getByTestId("blindpay-tracking")).toBeVisible({ timeout: 15_000 })
	expect(order.filter((step) => step !== "swap").slice(0, 4)).toEqual([
		"swap-confirm-1",
		"swap-confirm-2",
		"delegation",
		"confirm",
	])
	expect(await page.evaluate(() => (window as unknown as { __signed: number }).__signed)).toBe(2)
})

test("CCR-49: devnet shows no pay-with choice", async ({ page }) => {
	await installWallet(page)
	await page.route(/\/v1\/solana\/config$/, async (route) => {
		await route.fulfill({
			json: {
				cluster: "devnet",
				usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
				usdcDecimals: 6,
				label: "Solana USDC (devnet)",
				swapInputAssets: [],
			},
		})
	})
	await page.route(/\/v1\/payments\/pay_sender$/, async (route) => {
		await route.fulfill({ json: senderPayment("approve") })
	})
	await page.goto("/payments/pay_sender")
	await expect(page.getByTestId("blindpay-confirm")).toBeVisible()
	await expect(page.getByTestId("blindpay-pay-with")).toHaveCount(0)
})
