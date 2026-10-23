import { describe, expect, it } from "vitest"
import type { LegKind } from "@flexipay/domain"
import {
	AssertionFailure,
	expectKinds,
	expectNoEvent,
	expectPaid,
	expectReasons,
	expectTxRef,
	expectWaitingForClaim,
	payment,
} from "../../scripts/demo/lib/assertions.ts"
import { assertExactlyTwoPayoutAttemptsThenRefund } from "../../scripts/demo/lib/contract-gaps.ts"
import { loadFixtures } from "../../scripts/demo/lib/fixtures.ts"
import { BlockedError } from "../../scripts/demo/lib/report.ts"
import type { EventView } from "../../scripts/demo/lib/types.ts"

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
const brPayout = { kind: "payout", rail: "sim_bank_br_pix", status: "failed" }

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

	it("accepts a claim route that is paid at settle", () => {
		expect(() =>
			expectPaid(
				payment({
					id: "pay_2",
					status: "paid",
					legs: [collect, convert, settle],
				}),
			),
		).not.toThrow()
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

	it("requires an explanatory reason, not non-empty prose", () => {
		const exclusion = [/crypto/i, /compan/i, /not allowed/i]
		expect(() =>
			expectReasons(
				["Crypto leg not allowed for companies in this corridor"],
				exclusion,
				"reasons",
			),
		).not.toThrow()
		expect(() =>
			expectReasons(["Crypto is unavailable"], exclusion, "reasons"),
		).toThrow(/compan/)
		expect(() =>
			expectReasons(["Company route"], exclusion, "reasons"),
		).toThrow(/crypto/)
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

const attemptRef = (attempt: number): string =>
	`sim_bank_br_pix:pay_1:leg_5:${attempt}`

const payoutFailureEvent = (ref: string): EventView => ({
	type: "leg.failed",
	snapshot: {
		legs: [
			{
				kind: "collect",
				rail: "sim_bank_us_ach",
				status: "succeeded",
				externalRef: null,
				error: null,
			},
			{ kind: "convert", rail: "sim_fx", status: "succeeded" },
			{
				kind: "settle",
				rail: "stellar_usdc",
				status: "succeeded",
				externalRef: "mock-tx-1",
			},
			{ kind: "convert", rail: "sim_fx", status: "succeeded" },
			{
				...brPayout,
				externalRef: ref,
				error: {
					code: "sandbox_forced_failure",
					message: "forced by sandbox",
				},
			},
		],
	},
})

const refundedPayment = () =>
	payment({
		id: "pay_1",
		status: "refunded",
		legs: [
			collect,
			convert,
			settle,
			convert,
			{
				...brPayout,
				externalRef: attemptRef(2),
				error: {
					code: "sandbox_forced_failure",
					message: "forced by sandbox",
				},
			},
		],
	})

const twoFailures = (): EventView[] => [
	{ type: "payment.funded" },
	payoutFailureEvent(attemptRef(1)),
	payoutFailureEvent(attemptRef(2)),
	{ type: "payment.refunded" },
]

describe("DF4 payout attempt evidence", () => {
	it("proves two distinct attempts then a refund", () => {
		const evidence = assertExactlyTwoPayoutAttemptsThenRefund(
			refundedPayment(),
			twoFailures(),
			"sim_bank_br_pix",
		)
		expect(evidence.refs).toEqual([attemptRef(1), attemptRef(2)])
	})

	it("rejects no retry, a third attempt and a reused reference", () => {
		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment(),
				[
					{ type: "payment.funded" },
					payoutFailureEvent(attemptRef(1)),
					{ type: "payment.refunded" },
				],
				"sim_bank_br_pix",
			),
		).toThrow(/only 1/)
		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment(),
				[
					...twoFailures().slice(0, 3),
					payoutFailureEvent(attemptRef(3)),
					{ type: "payment.refunded" },
				],
				"sim_bank_br_pix",
			),
		).toThrow(/third payout attempt/)
		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment(),
				[
					payoutFailureEvent(attemptRef(1)),
					payoutFailureEvent(attemptRef(1)),
					{ type: "payment.refunded" },
				],
				"sim_bank_br_pix",
			),
		).toThrow(/distinct Leg.externalRef/)
	})

	it("rejects attempt 2 and 3 instead of the first try and one retry", () => {
		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment(),
				[
					payoutFailureEvent(attemptRef(2)),
					payoutFailureEvent(attemptRef(3)),
					{ type: "payment.refunded" },
				],
				"sim_bank_br_pix",
			),
		).toThrow(/attempt 1 and retry 2/)
	})

	it("blocks when the snapshot cannot identify the attempt", () => {
		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment(),
				[
					{ type: "leg.failed" },
					payoutFailureEvent(attemptRef(2)),
					{ type: "payment.refunded" },
				],
				"sim_bank_br_pix",
			),
		).toThrow(BlockedError)
		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment(),
				[
					{ type: "leg.failed", snapshot: {} },
					payoutFailureEvent(attemptRef(2)),
					{ type: "payment.refunded" },
				],
				"sim_bank_br_pix",
			),
		).toThrow(BlockedError)
		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment(),
				[
					{
						type: "leg.failed",
						snapshot: { legs: [{ ...brPayout }] },
					},
					payoutFailureEvent(attemptRef(2)),
					{ type: "payment.refunded" },
				],
				"sim_bank_br_pix",
			),
		).toThrow(BlockedError)
	})

	it("rejects a paid payment and a successful payout", () => {
		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				payment({ id: "pay_1", status: "paid", legs: [collect, payout] }),
				twoFailures(),
				"sim_bank_br_pix",
			),
		).toThrow(/expected refunded/)
		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				payment({
					id: "pay_1",
					status: "refunded",
					legs: [collect, { ...brPayout, status: "succeeded" }],
				}),
				twoFailures(),
				"sim_bank_br_pix",
			),
		).toThrow(/expected failed/)
	})
})

describe("quote fixtures", () => {
	it("names feeMode explicitly on every flow, with no inferred default", () => {
		const fixtures = loadFixtures()
		for (const [id, flow] of Object.entries(fixtures.flows)) {
			expect(flow.feeMode, id).toMatch(/^(PayerPays|RecipientPays)$/)
		}
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
