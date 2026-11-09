import { expect, test } from "@playwright/test"

test("public proof page shows aggregate Solana numbers without signing in", async ({
	page,
}) => {
	await page.route(/\/v1\/stats\/solana$/, (route) =>
		route.fulfill({
			json: {
				cluster: "mainnet-beta",
				since: null,
				settledPayments: 1234,
				deliveredPayments: 1200,
				volume: [{ asset: "USDC", amount: "56789.12" }],
				uniqueWallets: 987,
				repeatWallets: 321,
				generatedAt: "2026-11-16T10:00:00.000Z",
			},
		}),
	)
	await page.goto("/proof")
	await expect(
		page.getByRole("heading", { name: "Payments settled on Solana" }),
	).toBeVisible()
	await expect(page.getByTestId("proof-network")).toHaveText("Solana mainnet")
	await expect(page.getByTestId("proof-stats")).toContainText("1,234")
	await expect(page.getByTestId("proof-stats")).toContainText("321")
	await expect(page.getByTestId("proof-volume")).toContainText("56,789.12 USDC")
	await expect(page).toHaveURL(/\/proof$/)
})
