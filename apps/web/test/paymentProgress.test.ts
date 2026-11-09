import assert from "node:assert/strict"
import { type Leg, type PaymentStatus } from "@flexipay/web-lib/contract"
import { describe, test } from "vitest"
import {
	initialsOf,
	isWaitingForSender,
	paymentHeadline,
	paymentProgress,
} from "../src/payments/paymentProgress.ts"

type L = Pick<Leg, "kind" | "status">
const route = (
	statuses: [Leg["status"], Leg["status"], Leg["status"], Leg["status"]],
): L[] => [
	{ kind: "collect", status: statuses[0] },
	{ kind: "convert", status: statuses[1] },
	{ kind: "settle", status: statuses[2] },
	{ kind: "payout", status: statuses[3] },
]
const shape = (steps: ReturnType<typeof paymentProgress>) =>
	steps.map((step) => `${step.label}:${step.state}`)

describe("paymentProgress", () => {
	test("waiting for the sender: first step is current", () => {
		assert.deepEqual(
			shape(
				paymentProgress({
					status: "awaiting_funding",
					legs: route(["pending", "pending", "pending", "pending"]),
				}),
			),
			[
				"You pay:current",
				"Converting:todo",
				"Sent to their account:todo",
				"Delivered:todo",
			],
		)
	})

	test("processing with conversion done: on its way is current", () => {
		assert.deepEqual(
			shape(
				paymentProgress({
					status: "processing",
					legs: route(["succeeded", "succeeded", "succeeded", "processing"]),
				}),
			),
			[
				"We got your money:done",
				"Converting:done",
				"Sent to their account:current",
				"Delivered:todo",
			],
		)
	})

	test("a wallet payment still owed keeps the pay step current", () => {
		const steps = paymentProgress({
			status: "processing",
			legs: route(["succeeded", "succeeded", "processing", "pending"]),
			funded: true,
			senderActionNeeded: true,
		})
		assert.equal(steps[0]?.label, "You pay")
		assert.equal(steps[0]?.state, "current")
	})

	test("no conversion leg: three steps, all done when paid", () => {
		const steps = paymentProgress({
			status: "paid",
			legs: [
				{ kind: "collect", status: "succeeded" },
				{ kind: "payout", status: "succeeded" },
			],
		})
		assert.deepEqual(shape(steps), [
			"We got your money:done",
			"Sent to their account:done",
			"Delivered:done",
		])
	})

	test("refunded keeps finished steps and ends on money returned", () => {
		const steps = paymentProgress({
			status: "refunded",
			legs: route(["succeeded", "succeeded", "succeeded", "failed"]),
			funded: true,
		})
		assert.deepEqual(shape(steps), [
			"We got your money:done",
			"Converting:done",
			"Money returned to you:stopped",
		])
	})

	test("expired before paying shows only the stopped step", () => {
		assert.deepEqual(
			shape(
				paymentProgress({
					status: "expired",
					legs: route(["pending", "pending", "pending", "pending"]),
				}),
			),
			["Expired:stopped"],
		)
	})

	test("failed, refunding and cancelled use plain words", () => {
		const label = (status: PaymentStatus) =>
			paymentProgress({ status, legs: [] }).at(-1)?.label
		assert.equal(label("failed"), "Payment stopped")
		assert.equal(label("refunding"), "Returning your money")
		assert.equal(label("cancelled"), "Cancelled")
	})
})

describe("paymentHeadline", () => {
	test("every status has a plain sentence", () => {
		const statuses: PaymentStatus[] = [
			"quoted",
			"awaiting_funding",
			"funded",
			"processing",
			"paid",
			"failed",
			"refunding",
			"refunded",
			"cancelled",
			"expired",
		]
		for (const status of statuses) {
			const text = paymentHeadline(status, "Maria")
			assert.ok(text.length > 0)
			assert.doesNotMatch(text, /leg|rail|adapter|API/i)
		}
		assert.equal(paymentHeadline("paid", "Maria"), "Delivered to Maria.")
	})

	test("isWaitingForSender", () => {
		assert.equal(isWaitingForSender("awaiting_funding"), true)
		assert.equal(isWaitingForSender("processing"), false)
	})
})

describe("initialsOf", () => {
	test("takes first and last initials", () => {
		assert.equal(initialsOf("Maria Santos"), "MS")
		assert.equal(initialsOf("maria de la cruz"), "MC")
		assert.equal(initialsOf("rcp_1"), "R")
		assert.equal(initialsOf("  "), "?")
		assert.equal(initialsOf("123"), "?")
	})
})
