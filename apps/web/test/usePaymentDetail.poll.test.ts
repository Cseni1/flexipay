import assert from "node:assert/strict"
import { describe, test } from "vitest"
import {
	isWaitingOnLeg,
	shouldPollPayment,
} from "../src/hooks/usePaymentDetail"

const p = (status: string, legStatuses: string[]) =>
	({ status, legs: legStatuses.map((s) => ({ status: s })) }) as never

describe("payment detail poll rules", () => {
	test("keeps refreshing while the payment is moving, including between legs and after funding", () => {
		assert.equal(shouldPollPayment(p("funded", ["pending"])), true)
		assert.equal(
			shouldPollPayment(p("processing", ["succeeded", "pending"])),
			true,
		)
		assert.equal(shouldPollPayment(p("refunding", ["failed"])), true)
		assert.equal(shouldPollPayment(p("paid", ["succeeded"])), false)
		assert.equal(shouldPollPayment(p("failed", ["failed"])), false)
		assert.equal(shouldPollPayment(p("refunded", ["failed"])), false)
	})

	test("waits (10 s, 'Waiting for …') only while a leg is with the partner", () => {
		assert.equal(
			isWaitingOnLeg(p("processing", ["succeeded", "processing"])),
			true,
		)
		assert.equal(
			isWaitingOnLeg(p("processing", ["succeeded", "pending"])),
			false,
		)
		assert.equal(isWaitingOnLeg(p("funded", ["pending"])), false)
	})
})
