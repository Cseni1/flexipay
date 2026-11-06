import assert from "node:assert/strict"
import { describe, test } from "vitest"

/**
 * Mirrors the poll decision in usePaymentDetail so we can unit-test the rules
 * without mounting React.
 */
const TERMINAL = new Set(["paid", "failed", "refunded", "cancelled", "expired"])

const shouldPoll = (status: string, legStatuses: string[]): boolean => {
	if (TERMINAL.has(status)) return false
	if (status !== "processing") return false
	return legStatuses.some((s) => s === "processing")
}

describe("payment detail poll rules", () => {
	test("polls only while payment and a leg are processing", () => {
		assert.equal(shouldPoll("processing", ["succeeded", "processing"]), true)
		assert.equal(shouldPoll("processing", ["succeeded", "succeeded"]), false)
		assert.equal(shouldPoll("paid", ["succeeded"]), false)
		assert.equal(shouldPoll("failed", ["failed"]), false)
		assert.equal(shouldPoll("funded", ["pending"]), false)
	})
})
