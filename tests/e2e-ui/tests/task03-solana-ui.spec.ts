import { expect, test } from "@playwright/test"

/**
 * Fixture-level UI wiring for TASK 03 Solana path (no live chain).
 * Live DEVNET proof: `node scripts/demo/run-task03-ui-proof.mjs`.
 */
test.describe("TASK 03 Solana UI wiring", () => {
	test("claim page offers Solana network and keeps bank/e-wallet without LIVE labels", async ({
		page,
	}) => {
		await page.route(/\/v1\/claims\/[^/]+$/, async (route) => {
			if (route.request().method() !== "GET") return route.fallback()
			await route.fulfill({
				json: {
					paymentId: "pay_task03",
					status: "open",
					paymentStatus: "processing",
					expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
					amount: { amount: "10000000", currency: "USDC" },
					corridor: {
						from: { country: "US", currency: "USD" },
						to: { country: "PH", currency: "USDC" },
					},
					allowedDestinationTypes: ["crypto_wallet"],
					simulated: true,
				},
			})
		})

		await page.goto("/claim/demo_token_task03")
		await page.getByRole("radio", { name: /Crypto wallet/i }).check()
		await expect(page.getByTestId("claim-crypto-network")).toBeVisible()
		await expect(
			page.getByRole("radio", { name: /Solana USDC \(devnet test\)/i }),
		).toBeChecked()
		await expect(
			page.getByText(/not labelled LIVE without a verified provider/i),
		).toBeVisible()
		await expect(page.getByText(/^LIVE$/)).toHaveCount(0)
		await expect(page.getByText(/Bank account.*LIVE|LIVE.*Bank/i)).toHaveCount(
			0,
		)
	})

	test("paid claim shows release evidence and explorer link", async ({
		page,
	}) => {
		const signature = "5" + "A".repeat(86)
		await page.route(/\/v1\/claims\/[^/]+$/, async (route) => {
			await route.fulfill({
				json: {
					paymentId: "pay_task03_paid",
					status: "accepted",
					paymentStatus: "paid",
					expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
					amount: { amount: "10000000", currency: "USDC" },
					corridor: {
						from: { country: "US", currency: "USD" },
						to: { country: "", currency: "USDC" },
					},
					allowedDestinationTypes: ["crypto_wallet"],
					simulated: true,
					releaseEvidence: {
						network: "solana",
						signature,
						explorerUrl: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
					},
				},
			})
		})

		await page.goto("/claim/demo_token_paid")
		await expect(page.getByTestId("claim-release-evidence")).toBeVisible()
		await expect(page.getByTestId("claim-explorer-link")).toHaveAttribute(
			"href",
			new RegExp(signature),
		)
		await expect(page.locator('[data-payment-status="paid"]')).toBeVisible()
	})
})
