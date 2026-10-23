import { A0_CONTRACT_ANSWERS } from "./a0-answers.ts"
import { fail, leg, record } from "./parse.ts"
import { BlockedError } from "./report.ts"
import type { EventView, LegView, PaymentView } from "./types.ts"

// DF4 acceptance uses only published evidence: each leg.failed event carries Event.snapshot,
// whose legs are Payment.legs. A retry must therefore show exactly two failed payout legs on the
// routed provider with distinct Leg.externalRef values, followed by one payment.refunded and no
// third attempt. If a snapshot omits the legs or the reference, the evidence is missing and the
// flow BLOCKS; it never infers an attempt from the fixture's fail count.

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

/**
 * Provider references for the failed payout legs in one leg.failed snapshot. A snapshot may be
 * cumulative (it can already contain the previous attempt), so every reference is returned and
 * the caller checks that the union is exactly two attempts.
 */
function failedPayoutRefs(
	event: EventView,
	index: number,
	expectedRail: string,
): string[] {
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
	return matches.map((candidate) => {
		const ref = candidate.externalRef
		if (!ref) {
			throw new BlockedError(
				MISSING_SNAPSHOT(
					`events[${index}].snapshot failed payout leg has no externalRef`,
				),
			)
		}
		return ref
	})
}

/**
 * A succeeded payout would mean the refunded payment had already paid out, even if the final
 * payment row was overwritten later. A pending or failed planning row is not a success.
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
			if (candidate.status === "succeeded") {
				fail(
					`DF4: events[${index}].snapshot shows payout ${candidate.externalRef ?? "(no ref)"} as succeeded; a refunded payment must not have a successful payout`,
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

	// Scan every published snapshot before extracting attempts, so a payout that succeeded at
	// some point is reported as such instead of being hidden by a later failed row.
	assertSnapshotsShowNoSuccessfulPayout(events, expectedRail)

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

	const eventRefs = failures.map(({ event, index }) => ({
		index,
		refs: failedPayoutRefs(event, index, expectedRail),
	}))
	const refs = [...new Set(eventRefs.flatMap(({ refs }) => refs))]
	if (refs.length !== 2) {
		fail(
			`DF4: the leg.failed snapshots show ${refs.length} distinct payout attempt(s) (${refs.join(", ") || "none"}), expected exactly two`,
		)
	}
	for (const { index, refs: seen } of eventRefs) {
		const distinct = new Set(seen)
		if (distinct.size !== seen.length) {
			fail(
				`DF4: events[${index}].snapshot repeats a payout externalRef; one leg.failed event must not duplicate an attempt`,
			)
		}
		if (distinct.size > 2) {
			fail(
				`DF4: events[${index}].snapshot carries ${distinct.size} failed payout attempts; a third attempt is visible`,
			)
		}
	}
	const attemptNumbers = refs.map((ref) => {
		const match = /:(\d+)$/.exec(ref)
		return match ? Number(match[1]) : undefined
	})
	const numbered = attemptNumbers.filter(
		(attempt): attempt is number => attempt !== undefined,
	)
	if (numbered.length > 0) {
		if (numbered.length !== attemptNumbers.length) {
			fail(
				"DF4: payout references mix numbered and unnumbered attempts; the retry sequence cannot be ordered",
			)
		}
		const sorted = [...numbered].sort((a, b) => a - b)
		if (sorted.join(",") !== "1,2") {
			fail(
				`DF4: payout attempts are ${sorted.join(", ")}, expected attempt 1 and retry 2`,
			)
		}
	}

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
	const finalRefs = new Set(
		payouts.flatMap((candidate) =>
			candidate.externalRef ? [candidate.externalRef] : [],
		),
	)
	if (finalRefs.size > 2) {
		fail(
			`DF4: payment.legs shows ${finalRefs.size} payout attempts; a third attempt is visible`,
		)
	}
	for (const ref of finalRefs) {
		if (!refs.includes(ref)) {
			fail(
				`DF4: payment.legs carries payout ${ref}, which has no leg.failed snapshot evidence`,
			)
		}
	}

	return { refs }
}
