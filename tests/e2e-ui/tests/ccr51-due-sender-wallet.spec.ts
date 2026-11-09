import { expect, test, type Page } from "@playwright/test"
import { Keypair } from "@solana/web3.js"
import { paymentDetailFixture } from "./fixtures"

// CCR-51: a Due payout paid from the sender's own wallet. The API, the wallet and the Solana RPC
// are mocked; nothing reaches Due or Solana.

const PAYMENT_ID = "pay_due"
const sender = Keypair.generate().publicKey
const SENDER = sender.toBase58()
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
const FUNDING_ADDRESS = Keypair.generate().publicKey.toBase58()
const REFERENCE = Keypair.generate().publicKey.toBase58()

const solanaConfig = {
	cluster: "devnet",
	assets: [{ asset: "USDC", mint: USDC_MINT, decimals: 6 }],
	usdcMint: USDC_MINT,
	usdcDecimals: 6,
	explorerTxUrlTemplate:
		"https://explorer.solana.com/tx/{signature}?cluster=devnet",
	publicRpcUrl: "https://api.devnet.solana.com",
	label: "Solana (devnet)",
}

type Phase = "pay" | "funded" | "expired" | "failed"

function duePayment(phase: Phase) {
	const base = paymentDetailFixture(phase === "pay" ? "awaiting_funding" : "processing")
	const settle = {
		...base.legs[2]!,
		kind: "settle" as const,
		rail: "sender_wallet_due",
		providerId: "due_sandbox",
		status:
			phase === "pay" ? "pending" : phase === "expired" ? "failed" : "succeeded",
		externalRef: null,
		lockTxRef: null,
		releaseTxRef: phase === "funded" || phase === "failed" ? "sig" : null,
		error:
			phase === "expired"
				? {
						code: "funding_expired",
						message:
							"Due's 2-hour window to receive the USDC closed before FlexiPay saw your transfer.",
					}
				: null,
	}
	const payout = {
		...base.legs[4]!,
		kind: "payout" as const,
		rail: "due_sandbox",
		providerId: "due_sandbox",
		status:
			phase === "failed" ? "failed" : phase === "funded" ? "processing" : "pending",
		externalRef: phase === "pay" ? null : "tfr_1",
		error:
			phase === "failed"
				? {
						code: "provider_down",
						message: "Due could not complete the payout (Due transfer failed)",
					}
				: null,
	}
	return {
		...base,
		id: PAYMENT_ID,
		status:
			phase === "pay"
				? "awaiting_funding"
				: phase === "funded"
					? "processing"
					: phase,
		legs: [settle, payout],
		events: base.events.map((event) => ({ ...event, paymentId: PAYMENT_ID })),
	}
}

const funding = (state: "awaiting_transfer" | "funded") => ({
	paymentId: PAYMENT_ID,
	paymentStatus: "processing",
	state,
	transferId: "tfr_1",
	cluster: "devnet",
	asset: "USDC",
	mint: USDC_MINT,
	decimals: 6,
	amount: "99700001",
	recipient: FUNDING_ADDRESS,
	reference: REFERENCE,
	senderWallet: SENDER,
	expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
	signature: null,
	explorerTxUrlTemplate: solanaConfig.explorerTxUrlTemplate,
})

async function installWallet(page: Page) {
	await page.addInitScript(
		({ address, key }: { address: string; key: number[] }) => {
			const account = {
				address,
				publicKey: new Uint8Array(key),
				chains: ["solana:devnet"],
				features: ["solana:signAndSendTransaction"],
			}
			const wallet = {
				version: "1.0.0",
				name: "Phantom",
				icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
				chains: ["solana:devnet"],
				accounts: [] as (typeof account)[],
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
					"standard:events": { version: "1.0.0", on: () => () => {} },
					"solana:signAndSendTransaction": {
						version: "1.0.0",
						supportedTransactionVersions: ["legacy", 0],
						signAndSendTransaction: async () => {
							const signature = new Uint8Array(64)
							signature[0] = 7
							;(window as unknown as { __signed: number }).__signed = 1
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
		},
		{ address: SENDER, key: Array.from(sender.toBytes()) },
	)
}

async function mockSolanaRpc(page: Page) {
	await page.route(/https:\/\/api\.devnet\.solana\.com\/?/, async (route) => {
		let body: { method?: string; id?: number } = {}
		try {
			body = JSON.parse(route.request().postData() ?? "{}")
		} catch {
			body = {}
		}
		const id = body.id ?? 1
		const result =
			body.method === "getBalance"
				? { context: { slot: 1 }, value: 2_000_000_000 }
				: body.method === "getTokenAccountBalance"
					? {
							context: { slot: 1 },
							value: {
								amount: "500000000",
								decimals: 6,
								uiAmount: 500,
								uiAmountString: "500",
							},
						}
					: body.method === "getLatestBlockhash"
						? {
								context: { slot: 1 },
								value: {
									blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
									lastValidBlockHeight: 999_999,
								},
							}
						: body.method === "getAccountInfo" ||
							  body.method === "getMultipleAccounts"
							? { context: { slot: 1 }, value: null }
							: null
		await route.fulfill({ json: { jsonrpc: "2.0", id, result } })
	})
	await page.route(/\/v1\/solana\/config$/, async (route) => {
		await route.fulfill({ json: solanaConfig })
	})
}

test("Due: pay from your wallet, approve, then Due has the USDC", async ({
	page,
}) => {
	let phase: Phase = "pay"
	let prepared = false
	let confirms = 0
	let preparedFor: string | null = null
	let confirmedSignature: string | null = null
	await installWallet(page)
	await mockSolanaRpc(page)
	await page.route(new RegExp(`/v1/payments/${PAYMENT_ID}$`), async (route) => {
		await route.fulfill({ json: duePayment(phase) })
	})
	await page.route(
		new RegExp(`/v1/payments/${PAYMENT_ID}/due/funding$`),
		async (route) => {
			if (route.request().method() === "POST") {
				preparedFor = (route.request().postDataJSON() as { walletAddress: string })
					.walletAddress
				prepared = true
				await route.fulfill({ json: funding("awaiting_transfer") })
				return
			}
			if (!prepared) {
				await route.fulfill({
					status: 409,
					json: { code: "funding_not_prepared", message: "Connect your wallet first" },
				})
				return
			}
			await route.fulfill({ json: funding("awaiting_transfer") })
		},
	)
	await page.route(
		new RegExp(`/v1/payments/${PAYMENT_ID}/due/confirm$`),
		async (route) => {
			confirms += 1
			confirmedSignature = (route.request().postDataJSON() as { signature: string })
				.signature
			if (confirms === 1) {
				await route.fulfill({
					status: 202,
					json: {
						status: "pending",
						paymentId: PAYMENT_ID,
						signature: confirmedSignature,
						message: "not yet",
					},
				})
				return
			}
			phase = "funded"
			await route.fulfill({
				json: {
					paymentId: PAYMENT_ID,
					paymentStatus: "processing",
					transferId: "tfr_1",
					signature: confirmedSignature,
					explorerUrl: "https://explorer.solana.com/tx/x?cluster=devnet",
				},
			})
		},
	)

	await page.goto(`/payments/${PAYMENT_ID}`)
	const next = page.getByTestId("payment-next-step")
	await expect(next).toContainText("Pay from your wallet")
	await expect(page.getByTestId("due-sender-panel")).toContainText(
		"FlexiPay never holds the money",
	)
	await expect(page.getByTestId("due-approve")).toBeDisabled()
	await page.getByTestId("solana-wallet-connect").click()
	await page.getByTestId("due-confirm").check()
	await expect(page.getByTestId("due-approve")).toBeEnabled()
	await page.getByTestId("due-approve").click()
	await expect(page.getByTestId("due-tracking")).toBeVisible({ timeout: 15_000 })
	await expect(page.getByTestId("due-sender-panel")).toHaveCount(0)
	expect(preparedFor).toBe(SENDER)
	expect(confirms).toBe(2)
	expect(confirmedSignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{60,90}$/)
})

test("Due: the amount and deadline show once the transfer is set up", async ({
	page,
}) => {
	await installWallet(page)
	await mockSolanaRpc(page)
	await page.route(new RegExp(`/v1/payments/${PAYMENT_ID}$`), async (route) => {
		await route.fulfill({ json: duePayment("pay") })
	})
	await page.route(
		new RegExp(`/v1/payments/${PAYMENT_ID}/due/funding$`),
		async (route) => {
			await route.fulfill({ json: funding("awaiting_transfer") })
		},
	)
	await page.goto(`/payments/${PAYMENT_ID}`)
	const facts = page.getByTestId("due-funding-facts")
	await expect(facts).toContainText("99.700001 USDC")
	await expect(facts).toContainText("Solana (devnet, test network)")
	await expect(facts).toContainText("Send before")
})

test("Due: an expired or failed payment is explained", async ({ page }) => {
	let phase: Phase = "expired"
	await mockSolanaRpc(page)
	await page.route(new RegExp(`/v1/payments/${PAYMENT_ID}$`), async (route) => {
		await route.fulfill({ json: duePayment(phase) })
	})
	await page.goto(`/payments/${PAYMENT_ID}`)
	await expect(page.getByTestId("payment-problem")).toContainText(
		"2-hour window",
	)
	await expect(page.getByTestId("due-sender-panel")).toHaveCount(0)

	phase = "failed"
	await page.reload()
	await expect(page.getByTestId("payment-problem")).toContainText(
		"Due could not complete the payout",
	)
	await expect(page.getByTestId("due-failed")).toContainText(
		"FlexiPay never held your USDC",
	)
})
