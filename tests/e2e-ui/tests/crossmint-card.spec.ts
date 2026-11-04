import { expect, test, type BrowserContext, type Page } from "@playwright/test"

const ME = {
	via: "session",
	organization: { id: "org_1", name: "Ana" },
	user: { id: "u1", email: "ana@example.com", name: "Ana" },
}

/** Fixed harness wallet (secret never used on-chain in these mocks). */
const HARNESS = {
	secretKey: [
		23, 174, 242, 58, 200, 29, 101, 139, 51, 20, 203, 197, 142, 196, 245, 75,
		52, 197, 56, 19, 195, 226, 54, 202, 86, 112, 111, 45, 141, 44, 62, 69, 131,
		205, 16, 37, 82, 251, 158, 229, 90, 9, 175, 169, 89, 209, 56, 108, 212, 147,
		184, 110, 4, 247, 1, 196, 93, 103, 151, 32, 218, 205, 157, 140,
	],
	address: "9sVmVwo63Qit2WU9YQzbhEV6sZHt8w2YEUTgAfmUcVXh",
}

async function injectTestWallet(context: BrowserContext) {
	await context.addInitScript(
		({ secretKey }) => {
			;(
				window as unknown as {
					__FP_SOLANA_TEST_WALLET__?: { secretKey: number[] }
				}
			).__FP_SOLANA_TEST_WALLET__ = { secretKey }
		},
		{ secretKey: HARNESS.secretKey },
	)
}

async function mockShell(page: Page) {
	await page.route(/\/v1\/me$/, (route) => route.fulfill({ json: ME }))
	await page.route(/\/v1\/(corridors|payments)(\?.*)?$/, (route) =>
		route.fulfill({
			json: { corridors: [], payments: [], nextCursor: null },
		}),
	)
	await page.route(/\/v1\/solana\/config$/, (route) =>
		route.fulfill({
			json: {
				cluster: "devnet",
				usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
				usdcDecimals: 6,
				explorerTxUrlTemplate:
					"https://explorer.solana.com/tx/{signature}?cluster=devnet",
				publicRpcUrl: null,
				label: "Solana USDC (devnet)",
			},
		}),
	)
	await page.route(/\/healthz$/, (route) =>
		route.fulfill({ json: { status: "ok" } }),
	)
	// Block real Crossmint hosts only — do not match local paths (e.g. crossmint-wt/).
	await page.route(/https?:\/\/[^/]*crossmint[^/]*/i, (route) => route.abort())
}

async function connectHarnessWallet(page: Page) {
	await expect
		.poll(async () => page.getByTestId("solana-wallets-detected").textContent())
		.toContain("FlexiPay Devnet Test Wallet")
	await page.getByTestId("solana-wallet-connect").click()
	await expect(page.getByTestId("pay-from-connected")).toBeVisible({
		timeout: 15_000,
	})
}

test.describe("Pay-from Crossmint card checkout", () => {
	test("creates an onramp order then mounts embedded checkout", async ({
		page,
		context,
	}) => {
		await injectTestWallet(context)
		await mockShell(page)

		let posted: unknown = null
		await page.route(/\/v1\/onramp\/orders$/, async (route) => {
			if (route.request().method() !== "POST") return route.fallback()
			posted = route.request().postDataJSON()
			await route.fulfill({
				json: {
					orderId: "order_e2e_1",
					clientSecret: "cs_e2e_secret",
				},
			})
		})

		await page.goto("/pay-from")
		await page.getByLabel("Where are you buying from?").selectOption("US")
		await expect(page.getByTestId("add-funds-crossmint")).toBeVisible()
		await connectHarnessWallet(page)

		await page.getByTestId("crossmint-amount").fill("25")
		await page.getByTestId("crossmint-card-submit").click()

		await expect(page.getByTestId("crossmint-card-checkout")).toBeVisible({
			timeout: 10_000,
		})
		expect(posted).toEqual({
			walletAddress: HARNESS.address,
			amountUsd: "25",
		})
	})

	test("shows a friendly error when onramp returns 422", async ({
		page,
		context,
	}) => {
		await injectTestWallet(context)
		await mockShell(page)
		await page.route(/\/v1\/onramp\/orders$/, (route) =>
			route.fulfill({
				status: 422,
				json: {
					code: "validation_error",
					message: "Amount out of range",
					details: { reasons: ["amountUsd must be 5–100"] },
				},
			}),
		)

		await page.goto("/pay-from")
		await page.getByLabel("Where are you buying from?").selectOption("US")
		await connectHarnessWallet(page)
		await page.getByTestId("crossmint-amount").fill("25")
		await page.getByTestId("crossmint-card-submit").click()
		await expect(page.getByTestId("crossmint-error")).toContainText(
			"Amount out of range",
		)
		await expect(page.getByTestId("crossmint-card-checkout")).toHaveCount(0)
	})
})
