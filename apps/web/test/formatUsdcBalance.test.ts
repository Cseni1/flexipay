import { describe, expect, it } from "vitest"
import {
	FLEXIPAY_WALLET_CHAIN,
	FLEXIPAY_WALLET_CREATE_ON_LOGIN,
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
	it("targets Solana with email recovery", () => {
		expect(FLEXIPAY_WALLET_CHAIN).toBe("solana")
		expect(FLEXIPAY_WALLET_CREATE_ON_LOGIN.chain).toBe("solana")
		expect(FLEXIPAY_WALLET_CREATE_ON_LOGIN.recoveryMethods).toEqual([
			{ type: "email" },
		])
	})

	it("requires a non-empty client key", () => {
		expect(isFlexiPayWalletConfigured({})).toBe(false)
		expect(
			isFlexiPayWalletConfigured({ VITE_CROSSMINT_CLIENT_KEY: "  " }),
		).toBe(false)
		expect(
			isFlexiPayWalletConfigured({
				VITE_CROSSMINT_CLIENT_KEY: "ck_staging_test",
			}),
		).toBe(true)
	})
})
