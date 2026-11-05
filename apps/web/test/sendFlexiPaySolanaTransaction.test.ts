import assert from "node:assert/strict"
import { describe, test } from "vitest"
import { sendFlexiPaySolanaTransaction } from "../src/flexipayWallet/sendFlexiPaySolanaTransaction.ts"

describe("sendFlexiPaySolanaTransaction", () => {
	test("serializes the legacy tx and calls duck-typed sendTransaction", async () => {
		const calls: unknown[] = []
		const wallet = {
			address: "So11111111111111111111111111111111111111112",
			sendTransaction: async (params: unknown) => {
				calls.push(params)
				return {
					hash: "5FlexiPayStubSigaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					explorerLink: "https://explorer.solana.com",
					transactionId: "tx_1",
				}
			},
		}
		const legacy = {
			serialize: () => new Uint8Array([1, 2, 3, 4]),
		}
		const hash = await sendFlexiPaySolanaTransaction(wallet, legacy)
		assert.equal(
			hash,
			"5FlexiPayStubSigaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		)
		assert.equal(calls.length, 1)
		const payload = calls[0] as { serializedTransaction: string }
		assert.equal(typeof payload.serializedTransaction, "string")
		assert.ok(payload.serializedTransaction.length > 0)
	})

	test("throws when sendTransaction returns no hash", async () => {
		const wallet = {
			address: "So11111111111111111111111111111111111111112",
			sendTransaction: async () => ({ hash: "" }),
		}
		await assert.rejects(
			() =>
				sendFlexiPaySolanaTransaction(wallet, {
					serialize: () => new Uint8Array([9]),
				}),
			/no signature/i,
		)
	})
})
