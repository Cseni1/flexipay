import { describe, expect, it } from "vitest"
import type { LegKind } from "@flexipay/domain"
import {
	AssertionFailure,
	expectAttempts,
	expectKinds,
	expectNoEvent,
	expectPaid,
	expectReasons,
	expectTxRef,
	expectWaitingForClaim,
	payment,
} from "../../scripts/demo/lib/assertions.ts"

// Self-tests for the D1 harness. They do not touch the API and are not flow evidence: they prove
// that the assertion engine rejects the states a flow must never accept.

const collect = {
	kind: "collect",
	rail: "sim_bank_us_ach",
	status: "succeeded",
	externalRef: "mock-tx-1",
}
const convert = { kind: "convert", rail: "sim_fx", status: "succeeded" }
const settle = {
	kind: "settle",
	rail: "stellar_usdc",
	status: "succeeded",
	externalRef: "a".repeat(64),
}
const payout = { kind: "payout", rail: "sim_ewallet_ph", status: "succeeded" }

const paid = () =>
	payment({
		id: "pay_1",
		status: "paid",
		legs: [collect, convert, settle, convert, payout],
	})
const kinds = (...values: LegKind[]): LegKind[] => values

describe("payment assertions", () => {
	it("accepts a paid payment whose last leg is payout", () => {
		expect(() => expectPaid(paid())).not.toThrow()
	})

	it("rejects a paid payment with an unfinished or trailing non-payout leg", () => {
		expect(() =>
			expectPaid(
				payment({
					id: "pay_1",
					status: "paid",
					legs: [collect, { ...payout, status: "failed" }],
				}),
			),
		).toThrow(AssertionFailure)
		expect(() =>
			expectPaid(
				payment({ id: "pay_1", status: "paid", legs: [payout, collect] }),
			),
		).toThrow(/last leg/)
	})

	it("rejects a payment that is not paid", () => {
		expect(() =>
			expectPaid(
				payment({ id: "pay_1", status: "processing", legs: [collect, payout] }),
			),
		).toThrow(/processing/)
	})

	it("rejects a claim payment that was paid or released before acceptance", () => {
		expect(() =>
			expectWaitingForClaim(
				payment({
					id: "pay_1",
					status: "paid",
					legs: [collect, convert, settle],
				}),
			),
		).toThrow(/paid before/)
		expect(() =>
			expectWaitingForClaim(
				payment({
					id: "pay_1",
					status: "processing",
					legs: [collect, convert, settle],
				}),
			),
		).toThrow(/before acceptance/)
		expect(() =>
			expectWaitingForClaim(
				payment({
					id: "pay_1",
					status: "processing",
					legs: [collect, { ...settle, status: "processing" }],
				}),
			),
		).not.toThrow()
	})

	it("requires the documented leg order", () => {
		expect(() =>
			expectKinds(
				kinds("collect", "convert", "settle"),
				kinds("collect", "convert", "settle"),
				"route",
			),
		).not.toThrow()
		expect(() =>
			expectKinds(
				kinds("collect", "settle"),
				kinds("collect", "convert", "settle"),
				"route",
			),
		).toThrow(/leg kinds/)
	})

	it("counts attempts instead of trusting the final status", () => {
		const attempts = payment({
			id: "pay_1",
			status: "refunded",
			legs: [
				{
					kind: "payout",
					rail: "sim_bank_br_pix",
					status: "failed",
					attempt: 1,
				},
				{
					kind: "payout",
					rail: "sim_bank_br_pix",
					status: "failed",
					attempt: 2,
				},
			],
		}).legs
		expect(() => expectAttempts(attempts, "payout", 2, "legs")).not.toThrow()
		expect(() => expectAttempts(attempts, "payout", 1, "legs")).toThrow(
			/exactly 1/,
		)
	})

	it("requires an explanatory reason", () => {
		expect(() =>
			expectReasons(
				["Crypto leg not allowed for companies in this corridor"],
				[/crypto/i, /compan/i],
				"reasons",
			),
		).not.toThrow()
		expect(() => expectReasons(["best route"], [/crypto/i], "reasons")).toThrow(
			/no reason matches/,
		)
		expect(() => expectReasons([], [/crypto/i], "reasons")).toThrow(/empty/)
	})

	it("rejects an unexpected on-chain event", () => {
		expect(() =>
			expectNoEvent(["payment.paid"], "payment.onchain"),
		).not.toThrow()
		expect(() => expectNoEvent(["payment.onchain"], "payment.onchain")).toThrow(
			/unexpected/,
		)
	})
})

describe("transaction references", () => {
	it("accepts a mock reference only in mock mode", () => {
		expect(() => expectTxRef("mock-tx-2", "mock", "release")).not.toThrow()
		expect(() => expectTxRef("mock-tx-2", "stellar", "release")).toThrow(
			/Stellar/,
		)
	})

	it("accepts a 64-hex Stellar hash only in stellar mode", () => {
		expect(() =>
			expectTxRef("b".repeat(64), "stellar", "release"),
		).not.toThrow()
		expect(() => expectTxRef("b".repeat(64), "mock", "release")).toThrow(
			/mock reference/,
		)
		expect(() => expectTxRef("not-a-hash", "stellar", "release")).toThrow(
			/64-character/,
		)
		expect(() => expectTxRef(undefined, "stellar", "release")).toThrow(
			/no transaction reference/,
		)
	})
})
