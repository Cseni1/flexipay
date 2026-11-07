import assert from "node:assert/strict"
import { describe, test } from "vitest"
import { isSolanaSettleRail } from "../src/payments/solanaRails.ts"

describe("isSolanaSettleRail", () => {
	test("recognises solana settle rails only", () => {
		assert.equal(isSolanaSettleRail("solana_tgbp"), true)
		assert.equal(isSolanaSettleRail("solana_usdc"), true)
		assert.equal(isSolanaSettleRail("stellar_usdc"), false)
		assert.equal(isSolanaSettleRail(undefined), false)
	})
})
