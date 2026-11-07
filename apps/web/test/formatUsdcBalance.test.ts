import { describe, expect, it } from "vitest"
import {
	FLEXIPAY_WALLET_CHAIN,
	isFlexiPayWalletConfigured,
} from "../src/flexipayWallet/config"
import { formatUsdcBalance } from "../src/flexipayWallet/formatUsdcBalance"

describe("formatUsdcBalance", () => {
	it("formats a human amount string", () => {
		expect(formatUsdcBalance({ amount: "12.5" })).toMatch(/12\.5/)
	})

	it("formats rawAmount with decimals", () => {
		expect(formatUsdcBalance({ rawAmount: "1250000", decimals: 6 })).toMatch(
			/1\.25/,
		)
	})

	it("returns an em dash when empty", () => {
		expect(formatUsdcBalance(null)).toBe("—")
		expect(formatUsdcBalance({})).toBe("—")
	})
})

describe("flexipay wallet config", () => {
	it("targets Solana devnet", () => {
		// Privy embedded Solana wallet on devnet (Crossmint declined, 7 Nov 2026).
		expect(FLEXIPAY_WALLET_CHAIN).toBe("solana:devnet")
	})

	it("requires a non-empty Privy App ID", () => {
		expect(isFlexiPayWalletConfigured({})).toBe(false)
		expect(isFlexiPayWalletConfigured({ VITE_PRIVY_APP_ID: "  " })).toBe(false)
		expect(
			isFlexiPayWalletConfigured({
				VITE_PRIVY_APP_ID: "cm_test_app_id",
			}),
		).toBe(true)
	})
})
