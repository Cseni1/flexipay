import { describe, expect, it } from "vitest"
import type { LegKind } from "@flexipay/domain"
import {
	AssertionFailure,
	expectFrozenAccounting,
	expectKinds,
	expectNoEvent,
	expectPaid,
	expectPayerPaysSizing,
	expectPayoutId,
	expectReasons,
	expectTxRef,
	expectWaitingForClaim,
	payment,
	quote,
} from "../../scripts/demo/lib/assertions.ts"
import { assertExactlyTwoPayoutAttemptsThenRefund } from "../../scripts/demo/lib/contract-gaps.ts"
import { loadFixtures } from "../../scripts/demo/lib/fixtures.ts"
import type { EventView, LegView } from "../../scripts/demo/lib/types.ts"

// Self-tests for the D1 harness. They do not touch the API and are not flow evidence: they prove
// that the assertion engine rejects the states a flow must never accept.

const collect: LegView = {
	kind: "collect",
	rail: "sim_bank_us_ach",
	status: "succeeded",
	externalRef: "mock-tx-1",
}
const convert: LegView = {
	kind: "convert",
	rail: "sim_fx",
	status: "succeeded",
}
const settle: LegView = {
	kind: "settle",
	rail: "stellar_usdc",
	status: "succeeded",
	externalRef: "42",
	lockTxRef: "a".repeat(64),
	releaseTxRef: "b".repeat(64),
}
const payout: LegView = {
	kind: "payout",
	rail: "sim_ewallet_ph",
	status: "succeeded",
}
const brPayout: LegView = {
	kind: "payout",
	rail: "sim_bank_br_pix",
	status: "failed",
}

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
		// The meaning may be spread over several reasons; no single sentence is required.
		expect(() =>
			expectReasons(
				[
					"Crypto is unavailable for this destination",
					"Company recipients need a bank account",
					"Not allowed on this corridor",
				],
				exclusion,
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

const usd = (amount: string) => ({ amount, currency: "USD" })
const usdc = (amount: string) => ({ amount, currency: "USDC" })

const frozenQuote = (overrides: Record<string, unknown> = {}) =>
	quote({
		id: "qte_1",
		route: [
			{
				kind: "collect",
				rail: "sim_bank_us_ach",
				amountIn: usd("25000"),
				amountOut: usd("25000"),
			},
			{
				kind: "convert",
				rail: "sim_fx",
				amountIn: usd("25000"),
				amountOut: usdc("10100"),
			},
			{
				kind: "settle",
				rail: "stellar_usdc",
				amountIn: usdc("10000"),
				amountOut: usdc("10000"),
			},
		],
		reasons: ["stablecoin settlement"],
		amount: { side: "send", value: usd("25000") },
		expectedReceive: usd("24950"),
		validUntil: "2026-10-23T15:00:00.000Z",
		simulated: true,
		feeMode: "PayerPays",
		fees: {
			legs: [{ kind: "settle", rail: "stellar_usdc", fee: usdc("50") }],
			flexiPayFee: usdc("50"),
			total: usdc("50"),
			settleUnlockedRemainder: usdc("50"),
		},
		...overrides,
	})

const frozenPayment = (overrides: Record<string, unknown> = {}) =>
	payment({
		id: "pay_1",
		status: "paid",
		legs: [
			{
				kind: "collect",
				rail: "sim_bank_us_ach",
				amountIn: usd("25000"),
				amountOut: usd("25000"),
				status: "succeeded",
			},
			{
				kind: "convert",
				rail: "sim_fx",
				amountIn: usd("25000"),
				amountOut: usdc("10100"),
				status: "succeeded",
			},
			{
				kind: "settle",
				rail: "stellar_usdc",
				amountIn: usdc("10000"),
				amountOut: usdc("10000"),
				status: "succeeded",
			},
		],
		...overrides,
	})

describe("CCR-13 frozen accounting", () => {
	it("accepts a payment that copied the quoted principal, fee and remainder", () => {
		expect(() =>
			expectFrozenAccounting(frozenQuote(), frozenPayment(), "test"),
		).not.toThrow()
	})

	it("accepts RecipientPays when the net is P - f(P)", () => {
		const recipientPays = frozenQuote({
			feeMode: "RecipientPays",
			route: [
				{
					kind: "collect",
					rail: "sim_bank_us_ach",
					amountIn: usd("25000"),
					amountOut: usd("25000"),
				},
				{
					kind: "convert",
					rail: "sim_fx",
					amountIn: usd("25000"),
					amountOut: usdc("10100"),
				},
				{
					kind: "settle",
					rail: "stellar_usdc",
					amountIn: usdc("10000"),
					amountOut: usdc("9950"),
				},
			],
			fees: {
				legs: [{ kind: "settle", rail: "stellar_usdc", fee: usdc("50") }],
				flexiPayFee: usdc("50"),
				total: usdc("50"),
				settleUnlockedRemainder: null,
			},
		})
		const paidNet = frozenPayment({
			legs: [
				{
					kind: "collect",
					rail: "sim_bank_us_ach",
					amountIn: usd("25000"),
					amountOut: usd("25000"),
					status: "succeeded",
				},
				{
					kind: "convert",
					rail: "sim_fx",
					amountIn: usd("25000"),
					amountOut: usdc("10100"),
					status: "succeeded",
				},
				{
					kind: "settle",
					rail: "stellar_usdc",
					amountIn: usdc("10000"),
					amountOut: usdc("9950"),
					status: "succeeded",
				},
			],
		})
		expect(() =>
			expectFrozenAccounting(recipientPays, paidNet, "test"),
		).not.toThrow()
		// A RecipientPays quote that keeps the gross net is self-inconsistent even when the payment
		// copied it faithfully.
		const grossQuote = frozenQuote({
			feeMode: "RecipientPays",
			fees: {
				legs: [{ kind: "settle", rail: "stellar_usdc", fee: usdc("50") }],
				flexiPayFee: usdc("50"),
				total: usdc("50"),
				settleUnlockedRemainder: null,
			},
		})
		expect(() =>
			expectFrozenAccounting(grossQuote, frozenPayment(), "test"),
		).toThrow(/RecipientPays settle net/)
	})

	it("rejects a payment that re-priced or dropped the frozen settle amounts", () => {
		const quoteView = frozenQuote()
		expect(() =>
			expectFrozenAccounting(
				quoteView,
				frozenPayment({
					legs: [
						{
							kind: "collect",
							rail: "sim_bank_us_ach",
							amountIn: usd("25000"),
							amountOut: usd("25000"),
							status: "succeeded",
						},
						{
							kind: "convert",
							rail: "sim_fx",
							amountIn: usd("25000"),
							amountOut: usdc("10100"),
							status: "succeeded",
						},
						{
							kind: "settle",
							rail: "stellar_usdc",
							amountIn: usdc("9999"),
							amountOut: usdc("10000"),
							status: "succeeded",
						},
					],
				}),
				"test",
			),
		).toThrow(/settle amountIn/)
		expect(() =>
			expectFrozenAccounting(
				quoteView,
				frozenPayment({
					legs: [
						{
							kind: "collect",
							rail: "sim_bank_us_ach",
							amountIn: usd("25000"),
							amountOut: usd("25000"),
							status: "succeeded",
						},
						{
							kind: "settle",
							rail: "stellar_usdc",
							amountIn: usdc("10000"),
							amountOut: usdc("10000"),
							status: "succeeded",
						},
					],
				}),
				"test",
			),
		).toThrow(/no convert leg/)
	})

	it("rejects a fee that differs from the quoted fee", () => {
		const quoteView = frozenQuote({
			fees: {
				legs: [{ kind: "settle", rail: "stellar_usdc", fee: usdc("49") }],
				flexiPayFee: usdc("50"),
				total: usdc("50"),
				settleUnlockedRemainder: usdc("50"),
			},
		})
		expect(() =>
			expectFrozenAccounting(quoteView, frozenPayment(), "test"),
		).toThrow(/settle fee/)
	})

	it("rejects a missing or wrong PayerPays remainder", () => {
		const noRemainder = frozenQuote({
			fees: {
				legs: [{ kind: "settle", rail: "stellar_usdc", fee: usdc("50") }],
				flexiPayFee: usdc("50"),
				total: usdc("50"),
				settleUnlockedRemainder: null,
			},
		})
		expect(() =>
			expectFrozenAccounting(noRemainder, frozenPayment(), "test"),
		).toThrow(/missing settleUnlockedRemainder/)
		const wrongRemainder = frozenQuote({
			fees: {
				legs: [{ kind: "settle", rail: "stellar_usdc", fee: usdc("50") }],
				flexiPayFee: usdc("50"),
				total: usdc("50"),
				settleUnlockedRemainder: usdc("49"),
			},
		})
		expect(() =>
			expectFrozenAccounting(wrongRemainder, frozenPayment(), "test"),
		).toThrow(/settleUnlockedRemainder 49/)
	})

	it("rejects a feeMode on a route without settle", () => {
		const domestic = frozenQuote({
			feeMode: "PayerPays",
			route: [
				{
					kind: "collect",
					rail: "sim_bank_us_ach",
					amountIn: usd("25000"),
					amountOut: usd("25000"),
				},
				{
					kind: "payout",
					rail: "sim_bank_us_ach",
					amountIn: usd("25000"),
					amountOut: usd("25000"),
				},
			],
			fees: {
				legs: [],
				flexiPayFee: usdc("0"),
				total: usdc("0"),
				settleUnlockedRemainder: null,
			},
		})
		expect(() =>
			expectFrozenAccounting(
				domestic,
				payment({
					id: "pay_1",
					status: "paid",
					legs: [
						{
							kind: "collect",
							rail: "sim_bank_us_ach",
							amountIn: usd("25000"),
							amountOut: usd("25000"),
							status: "succeeded",
						},
						{
							kind: "payout",
							rail: "sim_bank_us_ach",
							amountIn: usd("25000"),
							amountOut: usd("25000"),
							status: "succeeded",
						},
					],
				}),
				"test",
			),
		).toThrow(/no settle but feeMode/)
	})
})

describe("CCR-13 PayerPays sizing", () => {
	/** A=10100, 100 bps → P=10000, f(P)=100, remainder 0 (CCR-8 identities). */
	const sizedQuote = (principal: string, fee: string) =>
		frozenQuote({
			route: [
				{
					kind: "collect",
					rail: "sim_bank_us_ach",
					amountIn: usd("25000"),
					amountOut: usd("25000"),
				},
				{
					kind: "convert",
					rail: "sim_fx",
					amountIn: usd("25000"),
					amountOut: usdc("10100"),
				},
				{
					kind: "settle",
					rail: "stellar_usdc",
					amountIn: usdc(principal),
					amountOut: usdc(principal),
				},
			],
			fees: {
				legs: [{ kind: "settle", rail: "stellar_usdc", fee: usdc(fee) }],
				flexiPayFee: usdc(fee),
				total: usdc(fee),
				settleUnlockedRemainder: null,
			},
		})

	it("requires quote P and fee to match vault sizing identities", () => {
		expect(() =>
			expectPayerPaysSizing(sizedQuote("10000", "100"), "test"),
		).not.toThrow()
		// Fee 7 is not f(10000) for any 0..1000 bps, so sizing cannot hold.
		expect(() =>
			expectPayerPaysSizing(sizedQuote("10000", "7"), "test"),
		).toThrow(/not consistent with vault sizing/)
	})

	it("when deployed bps is supplied, requires exact P and f(P)", () => {
		expect(() =>
			expectPayerPaysSizing(sizedQuote("10000", "100"), 100, "test"),
		).not.toThrow()
		expect(() =>
			expectPayerPaysSizing(sizedQuote("10000", "100"), 50, "test"),
		).toThrow(/is not floor\(A\*10000\/\(10000\+50\)\)/)
	})

	it("skips a RecipientPays quote and rejects an inconsistent fee", () => {
		expect(() =>
			expectPayerPaysSizing(frozenQuote({ feeMode: "RecipientPays" }), "test"),
		).not.toThrow()
		expect(() =>
			expectPayerPaysSizing(sizedQuote("10000", "7"), "test"),
		).toThrow(/not consistent with vault sizing/)
	})
})

describe("CCR-12 settle references", () => {
	it("requires settle.externalRef to be the vault payoutId", () => {
		expect(expectPayoutId("42", "settle")).toBe("42")
		expect(() => expectPayoutId(undefined, "settle")).toThrow(
			/no settle payoutId/,
		)
		expect(() => expectPayoutId("0", "settle")).toThrow(/positive decimal/)
		expect(() => expectPayoutId("a".repeat(64), "settle")).toThrow(
			/positive decimal/,
		)
		expect(() => expectPayoutId("tx_abc", "settle")).toThrow(/positive decimal/)
	})
})

const payoutAttempt = (
	attempt: number,
	options: {
		ref?: string | null
		status?: LegView["status"]
		withAttempt?: boolean
	} = {},
): LegView => ({
	kind: "payout",
	rail: "sim_bank_br_pix",
	status: options.status ?? "failed",
	...(options.withAttempt === false ? {} : { attempt }),
	...(options.ref === undefined || options.ref === null
		? {}
		: { externalRef: options.ref }),
	...(options.status === "pending"
		? {}
		: {
				error: { code: "sandbox_forced_failure", message: "forced by sandbox" },
			}),
})

const baseLegs: LegView[] = [
	{
		kind: "collect",
		rail: "sim_bank_us_ach",
		status: "succeeded",
		externalRef: "mock-tx-1",
	},
	{ kind: "convert", rail: "sim_fx", status: "succeeded" },
	settle,
	{ kind: "convert", rail: "sim_fx", status: "succeeded" },
]

const failureEvent = (payouts: LegView[]): EventView => ({
	type: "leg.failed",
	snapshot: { legs: [...baseLegs, ...payouts] },
})

const refundedPayment = (legs: LegView[] = [payoutAttempt(2)]) =>
	payment({
		id: "pay_1",
		status: "refunded",
		legs: [...baseLegs, ...legs],
	})

const twoFailures = (ref?: string): EventView[] => [
	failureEvent([payoutAttempt(1, { ref })]),
	failureEvent([payoutAttempt(2, { ref })]),
	{ type: "payment.refunded" },
]

describe("DF4 payout attempt evidence", () => {
	it("proves attempts 1 and 2 then a refund even when the provider ref repeats", () => {
		const evidence = assertExactlyTwoPayoutAttemptsThenRefund(
			refundedPayment(),
			twoFailures("same-provider-ref"),
			"sim_bank_br_pix",
		)
		expect(evidence.attempts).toEqual([1, 2])
		expect(evidence.refs).toEqual(["same-provider-ref"])
	})

	it("accepts a retry whose provider refs were cleared", () => {
		const evidence = assertExactlyTwoPayoutAttemptsThenRefund(
			refundedPayment(),
			twoFailures(),
			"sim_bank_br_pix",
		)
		expect(evidence.attempts).toEqual([1, 2])
		expect(evidence.refs).toEqual([])
	})

	it("rejects no retry, a third attempt and attempts 2 and 3", () => {
		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment([payoutAttempt(1)]),
				[
					{ type: "payment.funded" },
					failureEvent([payoutAttempt(1)]),
					{ type: "payment.refunded" },
				],
				"sim_bank_br_pix",
			),
		).toThrow(/only 1/)

		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment(),
				[
					...twoFailures().slice(0, 2),
					failureEvent([payoutAttempt(3)]),
					{ type: "payment.refunded" },
				],
				"sim_bank_br_pix",
			),
		).toThrow(/third attempt|third payout attempt/)

		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment(),
				[
					failureEvent([payoutAttempt(2)]),
					failureEvent([payoutAttempt(3)]),
					{ type: "payment.refunded" },
				],
				"sim_bank_br_pix",
			),
		).toThrow(/third attempt|expected exactly 1 and 2/)
	})

	it("accepts cumulative snapshots and rejects a third attempt in one snapshot", () => {
		const cumulative = [
			failureEvent([payoutAttempt(1)]),
			failureEvent([payoutAttempt(1), payoutAttempt(2)]),
			{ type: "payment.refunded" },
		]
		expect(
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment(),
				cumulative,
				"sim_bank_br_pix",
			).attempts,
		).toEqual([1, 2])

		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment(),
				[
					failureEvent([payoutAttempt(1), payoutAttempt(2), payoutAttempt(3)]),
					{ type: "payment.refunded" },
				],
				"sim_bank_br_pix",
			),
		).toThrow(/third attempt is visible/)
	})

	it("rejects a successful payout in a snapshot and a refund before the failures", () => {
		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment(),
				[
					failureEvent([payoutAttempt(1)]),
					failureEvent([payoutAttempt(2, { status: "succeeded" })]),
					{ type: "payment.refunded" },
				],
				"sim_bank_br_pix",
			),
		).toThrow(/must not have a successful payout/)

		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment(),
				[
					{ type: "payment.refunded" },
					failureEvent([payoutAttempt(1)]),
					failureEvent([payoutAttempt(2)]),
				],
				"sim_bank_br_pix",
			),
		).toThrow(/follows payment.refunded/)
	})

	it("rejects attempts it cannot read from the published snapshot", () => {
		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment(),
				[
					failureEvent([payoutAttempt(1, { withAttempt: false })]),
					failureEvent([payoutAttempt(2)]),
					{ type: "payment.refunded" },
				],
				"sim_bank_br_pix",
			),
		).toThrow(/no attempt/)

		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment([payoutAttempt(2)]),
				[
					{ type: "leg.failed" },
					failureEvent([payoutAttempt(2)]),
					{ type: "payment.refunded" },
				],
				"sim_bank_br_pix",
			),
		).toThrow(/no Event.snapshot/)

		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment([payoutAttempt(2, { withAttempt: false })]),
				twoFailures(),
				"sim_bank_br_pix",
			),
		).toThrow(/payment.legs payout 1: payout leg has no attempt/)
	})

	it("rejects duplicate refund events", () => {
		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment(),
				twoFailures().concat({ type: "payment.refunded" }),
				"sim_bank_br_pix",
			),
		).toThrow(/2 payment\.refunded events/)
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
				refundedPayment([payoutAttempt(2, { status: "succeeded" })]),
				twoFailures(),
				"sim_bank_br_pix",
			),
		).toThrow(/expected failed/)
		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment([payoutAttempt(1)]),
				twoFailures(),
				"sim_bank_br_pix",
			),
		).toThrow(/expected the retry attempt 2/)
	})

	it("rejects a leg.failed that is not the routed payout", () => {
		expect(() =>
			assertExactlyTwoPayoutAttemptsThenRefund(
				refundedPayment(),
				[
					{
						type: "leg.failed",
						snapshot: {
							legs: [
								{
									kind: "payout",
									rail: "sim_bank_za_eft",
									status: "failed",
									attempt: 1,
								},
							],
						},
					},
					failureEvent([payoutAttempt(2)]),
					{ type: "payment.refunded" },
				],
				"sim_bank_br_pix",
			),
		).toThrow(
			/no failed sim_bank_br_pix payout leg|a payout on sim_bank_za_eft/,
		)
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
