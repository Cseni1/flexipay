import assert from "node:assert/strict"
import { describe, test } from "vitest"
import { ApiError } from "../src/api/client.ts"
import {
	friendlySolanaPayError,
	SOLANA_PAY_ERROR_COPY,
} from "../src/solana/friendlySolanaPayError.ts"

describe("friendlySolanaPayError", () => {
	test("maps internal_error and 5xx to prepare failed", () => {
		assert.equal(
			friendlySolanaPayError(
				new ApiError(500, "internal_error", '{"stack":"x"}'),
			),
			SOLANA_PAY_ERROR_COPY.PREPARE_FAILED,
		)
		assert.equal(
			friendlySolanaPayError(new ApiError(503, "http_503", "upstream")),
			SOLANA_PAY_ERROR_COPY.PREPARE_FAILED,
		)
	})

	test("maps wrong cluster, SOL fees, USDC, reject and expired", () => {
		assert.equal(
			friendlySolanaPayError(
				new Error("Wallet does not advertise solana:devnet"),
			),
			SOLANA_PAY_ERROR_COPY.WRONG_CLUSTER,
		)
		assert.equal(
			friendlySolanaPayError(new Error("no devnet SOL for network fees")),
			SOLANA_PAY_ERROR_COPY.NO_SOL_FEES,
		)
		assert.equal(
			friendlySolanaPayError(new Error("insufficient USDC")),
			SOLANA_PAY_ERROR_COPY.INSUFFICIENT_USDC,
		)
		assert.equal(
			friendlySolanaPayError(new Error("User rejected the request")),
			SOLANA_PAY_ERROR_COPY.USER_REJECTED,
		)
		assert.equal(
			friendlySolanaPayError(new ApiError(410, "claim_expired", "gone")),
			SOLANA_PAY_ERROR_COPY.EXPIRED,
		)
	})

	test("never returns raw JSON", () => {
		const message = friendlySolanaPayError('{"code":"boom","message":"secret"}')
		assert.equal(message, SOLANA_PAY_ERROR_COPY.FALLBACK)
		assert.equal(message.includes("{"), false)
	})
})
