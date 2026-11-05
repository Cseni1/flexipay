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
		id: `evt_${type}`,
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
	test("matches leg times by snapshot.legId; settle uses onchain/paid", () => {
		const events = [
			event("leg.succeeded", "2026-11-05T12:00:00.000Z", { legId: "leg_1" }),
			event("payment.onchain", "2026-11-05T12:05:00.000Z"),
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
