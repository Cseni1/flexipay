import assert from "node:assert/strict"
import { describe, test } from "vitest"
import { parseSolanaProof } from "../src/payments/solanaProof.ts"

describe("parseSolanaProof", () => {
	test("keeps valid numbers and volume rows", () => {
		const p = parseSolanaProof({
			cluster: "mainnet-beta",
			since: "2026-11-15T00:00:00.000Z",
			settledPayments: 12,
			deliveredPayments: 10,
			volume: [
				{ asset: "USDC", amount: "1250.5" },
				{ asset: "TGBP", amount: "bad" },
			],
			uniqueWallets: 9,
			repeatWallets: 3,
			generatedAt: "2026-11-16T10:00:00.000Z",
		})
		assert.equal(p.cluster, "mainnet-beta")
		assert.equal(p.settledPayments, 12)
		assert.deepEqual(p.volume, [{ asset: "USDC", amount: "1250.5" }])
		assert.equal(p.repeatWallets, 3)
	})

	test("falls back safely on junk", () => {
		const p = parseSolanaProof(null)
		assert.equal(p.cluster, "devnet")
		assert.equal(p.settledPayments, 0)
		assert.deepEqual(p.volume, [])
		assert.equal(p.since, null)
		assert.equal(
			parseSolanaProof({ settledPayments: -3, volume: "x" }).settledPayments,
			0,
		)
	})
})
