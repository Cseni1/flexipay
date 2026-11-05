import { expect, test } from "@playwright/test"

test.describe("Pay-from FlexiPay wallet (Crossmint stub)", () => {
	test("opens the stub wallet, shows address and USDC, and copies", async ({
		page,
		context,
		baseURL,
	}) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"], {
			origin: new URL(baseURL ?? "http://localhost").origin,
		})

		await page.goto("/pay-from")
		const card = page.getByTestId("flexipay-wallet-card")
		await expect(card).toBeVisible()
		await expect(page.getByTestId("flexipay-wallet-test-badge")).toHaveText(
			/Test wallet - devnet - no real money/i,
		)

		await page.getByTestId("flexipay-wallet-open").click()
		await expect(page.getByTestId("flexipay-wallet-ready")).toBeVisible()
		await expect(page.getByTestId("flexipay-wallet-address")).toContainText(
			/So11|…|^\w{4}/,
		)
		await expect(page.getByTestId("flexipay-wallet-usdc")).toContainText(
			/12\.5/,
		)

		await page.getByTestId("flexipay-wallet-copy").click()
		await expect(page.getByText("Copied")).toBeVisible()
	})
})
