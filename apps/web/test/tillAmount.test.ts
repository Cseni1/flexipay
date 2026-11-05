import assert from "node:assert/strict"
import { describe, test } from "vitest"
import { parsePaymentRequest } from "../src/api/paymentRequests.ts"
import {
	isValidMerchantWallet,
	normalizeTillLabel,
	parseTillAmountPounds,
	TILL_AMOUNT_MAX_MINOR,
	TILL_AMOUNT_MIN_MINOR,
} from "../src/payments/tillAmount.ts"

describe("till amount helpers", () => {
	test("parses pounds into GBP minor units within CCR-27 bounds", () => {
		assert.equal(parseTillAmountPounds("1"), String(TILL_AMOUNT_MIN_MINOR))
		assert.equal(parseTillAmountPounds("10.00"), "1000")
		assert.equal(parseTillAmountPounds("10000"), String(TILL_AMOUNT_MAX_MINOR))
		assert.equal(parseTillAmountPounds("0.99"), null)
		assert.equal(parseTillAmountPounds("10000.01"), null)
		assert.equal(parseTillAmountPounds("10.001"), null)
		assert.equal(parseTillAmountPounds(""), null)
	})

	test("validates Solana base58 wallets and optional labels", () => {
		assert.equal(
			isValidMerchantWallet("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
			true,
		)
		assert.equal(isValidMerchantWallet("too-short"), false)
		assert.equal(isValidMerchantWallet("0OIl" + "a".repeat(40)), false)
		assert.equal(normalizeTillLabel(""), undefined)
		assert.equal(normalizeTillLabel("  Table 4  "), "Table 4")
		assert.equal(normalizeTillLabel("x".repeat(41)), null)
	})
})

describe("payment request parser", () => {
	test("accepts a CCR-27 create/get shape and keeps solanaPayUrl", () => {
		const parsed = parsePaymentRequest({
			id: "pay_till_1",
			status: "waiting",
			amount: { amount: "100000000", currency: "TGBP" },
			merchantWallet: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
			reference: "ref_abc",
			solanaPayUrl:
				"solana:TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA?amount=10&spl-token=Mint111&reference=ref_abc&label=Till",
			expiresAt: "2026-11-05T12:30:00.000Z",
		})
		assert.equal(parsed.id, "pay_till_1")
		assert.equal(parsed.status, "waiting")
		assert.match(parsed.solanaPayUrl, /^solana:/)
		assert.equal(parsed.amount.currency, "TGBP")
	})
})
