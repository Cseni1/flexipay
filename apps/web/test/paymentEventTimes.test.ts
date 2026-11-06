import assert from "node:assert/strict"
import { type Event, type Leg } from "@flexipay/web-lib/contract"
import { describe, test } from "vitest"
import { formatLocalDateTime } from "../src/payments/formatPaymentTime.ts"
import {
	legEventTime,
	paymentMilestoneTimes,
} from "../src/payments/paymentEventTimes.ts"

const event = (
	type: string,
	createdAt: string,
	snapshot: Record<string, unknown> = {},
): Event =>
	({
		id: `evt_${type}_${createdAt}`,
		type,
		createdAt,
		paymentId: "pay_1",
		snapshot,
	}) as Event

const leg = (id: string, kind: Leg["kind"]): Leg =>
	({
		id,
		paymentId: "pay_1",
		kind,
		rail: "sim",
		providerId: "sim",
		amountIn: { amount: "1", currency: "GBP" },
		amountOut: { amount: "1", currency: "GBP" },
		status: "succeeded",
		attempt: 1,
		externalRef: null,
		lockTxRef: null,
		releaseTxRef: null,
		error: null,
		reversalOf: null,
		simulated: true,
	}) as Leg

describe("paymentEventTimes", () => {
	test("matches leg times by snapshot.legId", () => {
		const events = [
			event("leg.succeeded", "2026-11-05T12:00:00.000Z", { legId: "leg_1" }),
			event("payment.onchain", "2026-11-05T12:05:00.000Z", {
				legId: "leg_3",
			}),
			event("leg.succeeded", "2026-11-05T12:05:01.000Z", { legId: "leg_3" }),
			event("payment.paid", "2026-11-05T12:06:00.000Z"),
		]
		assert.equal(
			legEventTime(events, leg("leg_1", "collect")),
			"2026-11-05T12:00:00.000Z",
		)
		assert.equal(legEventTime(events, leg("leg_missing", "payout")), null)
		assert.equal(
			legEventTime(events, leg("leg_3", "settle")),
			"2026-11-05T12:05:00.000Z",
		)
	})

	test("settle never takes a time from another leg or bare payment.paid", () => {
		// Old matching used the first payment.onchain / payment.paid with no legId
		// filter, so settle would show WRONG_ONCHAIN or PAID_TIME here.
		const events = [
			event("payment.onchain", "2026-11-05T12:01:00.000Z", {
				legId: "leg_other",
			}),
			event("payment.paid", "2026-11-05T12:09:00.000Z"),
			event("leg.succeeded", "2026-11-05T12:04:00.000Z", {
				legId: "leg_settle",
			}),
		]
		assert.equal(
			legEventTime(events, leg("leg_settle", "settle")),
			"2026-11-05T12:04:00.000Z",
		)
		assert.equal(
			legEventTime(
				[
					event("payment.onchain", "2026-11-05T12:01:00.000Z", {
						legId: "leg_other",
					}),
					event("payment.paid", "2026-11-05T12:09:00.000Z"),
				],
				leg("leg_settle", "settle"),
			),
			null,
		)
	})

	test("milestone Created/Funded/Paid from events", () => {
		const times = paymentMilestoneTimes([
			event("payment.created", "2026-11-05T11:00:00.000Z"),
			event("payment.funded", "2026-11-05T11:10:00.000Z"),
			event("payment.paid", "2026-11-05T11:20:00.000Z"),
		])
		assert.deepEqual(times, {
			created: "2026-11-05T11:00:00.000Z",
			funded: "2026-11-05T11:10:00.000Z",
			paid: "2026-11-05T11:20:00.000Z",
		})
	})
})

describe("formatLocalDateTime", () => {
	test("formats a fixed instant in local timezone with seconds", () => {
		const label = formatLocalDateTime("2026-11-05T13:50:52.000Z")
		assert.match(label, /\d{1,2} \w{3} 2026, \d{2}:\d{2}:\d{2}/)
	})
})
