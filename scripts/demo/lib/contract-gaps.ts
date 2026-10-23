import { A0_CONTRACT_ANSWERS } from "./a0-answers.ts"
import { fail } from "./parse.ts"
import type { EventView, PaymentView } from "./types.ts"

// Remaining gaps are implementation (CC2/CC3), not unanswered A0 questions. See a0-answers.ts.

/**
 * DF4: prove exactly one retry (two failures) then refund using events/legs only.
 * Throws AssertionFailure if the terminal refunded state lacks two failure signals.
 */
export function assertExactlyOneRetryThenRefund(
	payment: PaymentView,
	events: readonly EventView[],
): void {
	const types = events.map((e) => e.type)
	if (payment.status !== "refunded") {
		fail(`DF4: payment ${payment.id} is ${payment.status}, expected refunded`)
	}
	if (!types.includes("payment.refunded")) {
		fail("DF4: missing payment.refunded event")
	}
	const failedEvents = types.filter((t) => t === "leg.failed").length
	const failedPayouts = payment.legs.filter(
		(l) => l.kind === "payout" && l.status === "failed",
	).length
	const failureSignals = Math.max(failedEvents, failedPayouts)
	if (failureSignals < 2) {
		fail(
			`DF4: need two failure signals for exactly one retry (leg.failed=${failedEvents}, failed payout legs=${failedPayouts}). ${A0_CONTRACT_ANSWERS.payoutAttempts}`,
		)
	}
	if (failedPayouts > 2 || failedEvents > 2) {
		fail(
			`DF4: more than one retry visible (leg.failed=${failedEvents}, failed payout legs=${failedPayouts})`,
		)
	}
}
