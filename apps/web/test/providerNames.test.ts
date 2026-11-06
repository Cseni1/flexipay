import assert from "node:assert/strict"
import { describe, test } from "vitest"
import { providerBadge, providerLabel } from "../src/payments/providerNames.ts"

describe("providerNames", () => {
	test("maps known partner and rail ids", () => {
		assert.equal(providerLabel("blindpay_sandbox"), "BlindPay")
		assert.equal(providerLabel("tazapay_sandbox"), "Tazapay")
		assert.equal(providerLabel("sim_bank_br_pix"), "Pix (simulated)")
		assert.equal(providerLabel("sim_fx"), "FX (simulated)")
		assert.equal(providerLabel("solana_usdc"), "Solana USDC")
		assert.equal(providerLabel("solana_tgbp"), "Solana tGBP")
		assert.equal(providerLabel("stellar_usdc"), "Stellar USDC")
	})

	test("falls back to title-case for unknown ids", () => {
		assert.equal(providerLabel("sim_ewallet_ph"), "Ewallet Ph")
		assert.equal(providerLabel("custom_rail_x"), "Custom Rail X")
	})

	test("badges: sim_* Simulated, *_sandbox Sandbox, never Live", () => {
		assert.equal(providerBadge(true, "blindpay_sandbox"), "Sandbox")
		assert.equal(providerBadge(true, "sim_bank_br_pix"), "Simulated")
		assert.equal(providerBadge(false, "solana_usdc"), "Sandbox")
		assert.notEqual(providerBadge(false, "solana_usdc"), "Live")
	})
})
