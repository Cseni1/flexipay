import { expect, test, type Page } from "@playwright/test"

const solanaConfig = {
	cluster: "devnet",
	usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
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

test.describe("Design pages: wallet and pay from", () => {
	test("sidebar reaches FlexiPay wallet and Pay from", async ({ page }) => {
		await mockSolanaConfig(page)
		await page.goto("/")
		const nav = page.getByRole("navigation", { name: "Primary" })
		await expect(nav.getByRole("link", { name: "Pay from" })).toBeVisible()
		await expect(
			nav.getByRole("link", { name: "FlexiPay wallet" }),
		).toBeVisible()

		await nav.getByRole("link", { name: "FlexiPay wallet" }).click()
		await expect(page).toHaveURL(/\/wallet$/)
		await expect(
			page.getByRole("heading", { name: "FlexiPay wallet", exact: true }),
		).toBeVisible()
		await expect(page.getByTestId("wallet-devnet-note")).toContainText("Devnet")
		await expect(page.getByTestId("embedded-wallet-soon")).toContainText(
			"Coming soon",
		)
		await expect(page.getByTestId("solana-wallet-connect")).toBeVisible()

		await nav.getByRole("link", { name: "Pay from" }).click()
		await expect(page).toHaveURL(/\/pay-from$/)
		await expect(
			page.getByRole("heading", { name: "Pay from", exact: true }),
		).toBeVisible()
		await expect(page.getByTestId("pay-from-devnet-note")).toContainText(
			"Devnet",
		)
		const soon = page.getByTestId("pay-from-coming-soon")
		await expect(soon).toContainText("Card")
		await expect(soon).toContainText("Cash out")
		await expect(soon).toContainText("Bank account")
		await expect(soon.getByText("Coming soon").first()).toBeVisible()
		await expect(page.getByTestId("solana-wallet-connect")).toBeVisible()
	})

	test("wallet page keeps receive empty until a wallet is connected", async ({
		page,
	}) => {
		await mockSolanaConfig(page)
		await page.goto("/wallet")
		await expect(page.getByTestId("wallet-hero")).toContainText(
			"No wallet connected",
		)
		await expect(page.getByTestId("wallet-receive")).toHaveCount(0)
		await expect(
			page.getByText("Connect a Solana wallet to show its receive address"),
		).toBeVisible()
	})

	test("send, detail and claim still expose contract headings", async ({
		page,
	}) => {
		await page.goto("/")
		await expect(
			page.getByRole("heading", { name: "Send a payment" }),
		).toBeVisible()
		await expect(page.getByRole("button", { name: "Get quote" })).toBeVisible()

		await page.route(/\/v1\/payments\/demo-payment$/, (route) =>
			route.fulfill({
				status: 404,
				json: { code: "not_found", message: "missing" },
			}),
		)
		await page.goto("/payments/demo-payment")
		await expect(
			page.getByRole("heading", { name: "Payment detail" }),
		).toBeVisible()

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
		await expect(page.getByText("devnet only")).toBeVisible()
		await expect(page.getByText("Simulated").first()).toBeVisible()
	})
})
