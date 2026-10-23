import { A0_CONTRACT_ANSWERS } from "./a0-answers.ts"
import { fail, leg, record } from "./parse.ts"
import type { EventView, LegView, PaymentView } from "./types.ts"

// DF4 acceptance uses only published evidence: each leg.failed event carries Event.snapshot,
// whose legs are Payment.legs. CCR-14 makes Leg.attempt the durable attempt source of truth.
// A retry keeps status `processing`, increments attempt to 2 and may clear provider refs, so
// distinct externalRef values are NOT required. The flow needs attempts 1 and 2, one retry and
// no attempt 3, followed by payment.refunded. Missing snapshot legs/attempts are contract
// defects, not a missing-route blocker; they fail acceptance instead of being inferred.

function snapshotLegs(event: EventView, index: number): LegView[] {
	if (event.snapshot === undefined) {
		fail(
			`DF4: events[${index}] has no Event.snapshot legs to attribute the attempt`,
		)
	}
	const snapshot = record(event.snapshot, `events[${index}].snapshot`)
	if (!Array.isArray(snapshot.legs)) {
		fail(`DF4: events[${index}].snapshot has no legs array`)
	}
	return snapshot.legs.map((row, legIndex) =>
		leg(row, `events[${index}].snapshot.legs[${legIndex}]`),
	)
}

function attemptOf(candidate: LegView, where: string): number {
	if (candidate.attempt === undefined) {
		fail(`${where}: payout leg has no attempt; CCR-14 requires Leg.attempt`)
	}
	if (candidate.attempt > 2) {
		fail(
			`${where}: payout attempt ${candidate.attempt}; a third attempt is visible`,
		)
	}
	return candidate.attempt
}

/** Payout legs in one leg.failed snapshot, on the routed provider. */
function failedPayoutAttempts(
	event: EventView,
	index: number,
	expectedRail: string,
): { attempt: number; ref?: string }[] {
	const legs = snapshotLegs(event, index)
	const matches = legs.filter(
		(candidate) =>
			candidate.kind === "payout" &&
			candidate.rail === expectedRail &&
			candidate.status === "failed",
	)
	if (matches.length === 0) {
		fail(
			`DF4: events[${index}] is leg.failed but its snapshot has no failed ${expectedRail} payout leg`,
		)
	}
	const otherPayout = legs.find(
		(candidate) =>
			candidate.kind === "payout" && candidate.rail !== expectedRail,
	)
	if (otherPayout) {
		fail(
			`DF4: events[${index}].snapshot has a payout on ${otherPayout.rail}, expected only ${expectedRail}; a re-route is not part of this scenario`,
		)
	}
	return matches.map((candidate, matchIndex) => ({
		attempt: attemptOf(
			candidate,
			`events[${index}].snapshot payout ${matchIndex + 1}`,
		),
		...(candidate.externalRef ? { ref: candidate.externalRef } : {}),
	}))
}

/**
 * A succeeded payout would mean the refunded payment had already paid out. A pending or failed
 * planning row is not a success. Every published payout leg must carry its durable attempt.
 */
function assertSnapshotsShowNoSuccessfulPayout(
	events: readonly EventView[],
	expectedRail: string,
): void {
	for (const [index, event] of events.entries()) {
		if (event.snapshot === undefined) continue
		const snapshot = record(event.snapshot, `events[${index}].snapshot`)
		if (!Array.isArray(snapshot.legs)) continue
		for (const [legIndex, row] of snapshot.legs.entries()) {
			const candidate = leg(row, `events[${index}].snapshot.legs[${legIndex}]`)
			if (candidate.kind !== "payout") continue
			attemptOf(candidate, `events[${index}].snapshot payout ${legIndex + 1}`)
			if (candidate.status === "succeeded") {
				fail(
					`DF4: events[${index}].snapshot shows payout attempt ${candidate.attempt} as succeeded; a refunded payment must not have a successful payout`,
				)
			}
			if (candidate.rail !== expectedRail) {
				fail(
					`DF4: events[${index}].snapshot has a payout on ${candidate.rail}, expected ${expectedRail}`,
				)
			}
		}
	}
}

/**
 * Proves exactly one payout retry: attempts 1 and 2 failed, the final durable attempt is 2, a
 * single payment.refunded follows, and no attempt 3 exists anywhere. Provider references may be
 * absent or repeated because CCR-14 allows the retry to clear them.
 */
export function assertExactlyTwoPayoutAttemptsThenRefund(
	payment: PaymentView,
	events: readonly EventView[],
	expectedRail: string,
): { attempts: number[]; refs: string[] } {
	if (payment.status !== "refunded") {
		fail(`DF4: payment ${payment.id} is ${payment.status}, expected refunded`)
	}

	assertSnapshotsShowNoSuccessfulPayout(events, expectedRail)

	const failures = events
		.map((event, index) => ({ event, index }))
		.filter(({ event }) => event.type === "leg.failed")
	if (failures.length < 2) {
		fail(
			`DF4: only ${failures.length} leg.failed event(s); one retry needs attempts 1 and 2. ${A0_CONTRACT_ANSWERS.payoutAttempts}`,
		)
	}
	if (failures.length > 2) {
		fail(
			`DF4: ${failures.length} leg.failed events; a third payout attempt is visible`,
		)
	}

	const failureAttempts = failures.map(({ event, index }) =>
		failedPayoutAttempts(event, index, expectedRail),
	)
	const attempts = [
		...new Set(
			failureAttempts.flatMap((rows) => rows.map((row) => row.attempt)),
		),
	].sort((a, b) => a - b)
	if (attempts.join(",") !== "1,2") {
		fail(
			`DF4: leg.failed snapshots show payout attempts ${attempts.join(", ") || "(none)"}, expected exactly 1 and 2`,
		)
	}
	const refs = [
		...new Set(
			failureAttempts
				.flatMap((rows) => rows.map((row) => row.ref))
				.filter((ref): ref is string => ref !== undefined),
		),
	]

	const refunds = events.filter((event) => event.type === "payment.refunded")
	if (refunds.length === 0) fail("DF4: missing payment.refunded event")
	if (refunds.length > 1)
		fail(`DF4: ${refunds.length} payment.refunded events for one payment`)
	const refundIndex = events.findIndex(
		(event) => event.type === "payment.refunded",
	)
	if (failures.some(({ index }) => index > refundIndex)) {
		fail(
			"DF4: a leg.failed event follows payment.refunded; a third attempt ran",
		)
	}
	const afterRefund = events.slice(refundIndex + 1)
	if (afterRefund.some((event) => event.type === "leg.failed")) {
		fail(
			"DF4: a leg.failed event follows payment.refunded; a third attempt ran",
		)
	}
	if (events.some((event) => event.type === "payment.paid")) {
		fail("DF4: a refunded payment also emitted payment.paid")
	}

	const payouts = payment.legs.filter(
		(candidate) => candidate.kind === "payout",
	)
	if (payouts.length === 0)
		fail("DF4: no failed payout is visible on the payment")
	if (payouts.some((candidate) => candidate.status !== "failed")) {
		fail(
			`DF4: visible payout attempts are ${payouts.map((candidate) => candidate.status).join(", ")}, expected failed`,
		)
	}
	if (payouts.some((candidate) => candidate.rail !== expectedRail)) {
		fail(
			`DF4: visible payout rails are ${payouts.map((candidate) => candidate.rail).join(", ")}, expected ${expectedRail}`,
		)
	}
	const finalAttempts = payouts.map((candidate, index) =>
		attemptOf(candidate, `payment.legs payout ${index + 1}`),
	)
	if (!finalAttempts.includes(2)) {
		fail(
			`DF4: final payout attempts are ${finalAttempts.join(", ")}, expected the retry attempt 2`,
		)
	}
	if (new Set(finalAttempts).size > 2) {
		fail("DF4: payment.legs shows more than two payout attempts")
	}

	return { attempts, refs }
}
