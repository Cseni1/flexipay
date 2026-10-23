import { A0_CONTRACT_ANSWERS } from "./a0-answers.ts"
import { fail, leg, record } from "./parse.ts"
import { BlockedError } from "./report.ts"
import type { EventView, LegView, PaymentView } from "./types.ts"

// DF4 acceptance uses only published evidence: each leg.failed event carries Event.snapshot,
// whose legs are Payment.legs. A retry must therefore show two failed payout legs on the routed
// provider with distinct Leg.externalRef values, followed by payment.refunded and no third
// failure. If a snapshot omits the legs or the reference, the evidence is missing and the flow
// BLOCKS; it never infers an attempt from the fixture's fail count.

const MISSING_SNAPSHOT = (detail: string) => [
	{
		what: "DF4 cannot attribute a payout attempt from Event.snapshot",
		owner: "CC2 (orchestrator)",
		detail: `${detail}. Event.snapshot must contain the published Payment.legs for each leg.failed event, including the failed payout leg's externalRef; no new API field is required.`,
	},
]

function snapshotLegs(event: EventView, index: number): LegView[] {
	if (event.snapshot === undefined) {
		throw new BlockedError(MISSING_SNAPSHOT(`events[${index}] has no snapshot`))
	}
	const snapshot = record(event.snapshot, `events[${index}].snapshot`)
	if (!Array.isArray(snapshot.legs)) {
		throw new BlockedError(
			MISSING_SNAPSHOT(`events[${index}].snapshot has no legs array`),
		)
	}
	return snapshot.legs.map((row, legIndex) =>
		leg(row, `events[${index}].snapshot.legs[${legIndex}]`),
	)
}

/** The failed payout leg this event reports, with the provider reference of that attempt. */
function failedPayoutRef(
	event: EventView,
	index: number,
	expectedRail: string,
): string {
	const matches = snapshotLegs(event, index).filter(
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
	const ref = matches.at(-1)?.externalRef
	if (!ref) {
		throw new BlockedError(
			MISSING_SNAPSHOT(
				`events[${index}].snapshot failed payout leg has no externalRef`,
			),
		)
	}
	return ref
}

/**
 * Proves exactly two payout attempts (the first try plus one retry), then a refund, and no third
 * attempt. Throws BLOCKED when the API publishes no attributable attempt evidence; throws
 * AssertionFailure when the published evidence shows any other count.
 */
export function assertExactlyTwoPayoutAttemptsThenRefund(
	payment: PaymentView,
	events: readonly EventView[],
	expectedRail: string,
): { refs: string[] } {
	if (payment.status !== "refunded") {
		fail(`DF4: payment ${payment.id} is ${payment.status}, expected refunded`)
	}

	const failures = events
		.map((event, index) => ({ event, index }))
		.filter(({ event }) => event.type === "leg.failed")
	if (failures.length < 2) {
		fail(
			`DF4: only ${failures.length} leg.failed event(s); exactly one retry needs two failures. ${A0_CONTRACT_ANSWERS.payoutAttempts}`,
		)
	}
	if (failures.length > 2) {
		fail(
			`DF4: ${failures.length} leg.failed events; a third payout attempt is visible`,
		)
	}

	const refs = failures.map(({ event, index }) =>
		failedPayoutRef(event, index, expectedRail),
	)
	if (new Set(refs).size !== refs.length) {
		fail(
			`DF4: the two leg.failed events reuse externalRef ${refs[0]}; two attempts need distinct Leg.externalRef values`,
		)
	}
	const attemptNumbers = refs.map((ref) => {
		const match = /:(\d+)$/.exec(ref)
		return match ? Number(match[1]) : undefined
	})
	if (attemptNumbers.every((attempt) => attempt !== undefined)) {
		const sorted = [...(attemptNumbers as number[])].sort((a, b) => a - b)
		if (sorted[0] !== 1 || sorted[1] !== 2) {
			fail(
				`DF4: payout attempts are ${sorted.join(", ")}, expected attempt 1 and retry 2`,
			)
		}
	}

	const refundIndex = events.findIndex(
		(event) => event.type === "payment.refunded",
	)
	if (refundIndex < 0) fail("DF4: missing payment.refunded event")
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

	return { refs }
}
