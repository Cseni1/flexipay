import { type Event, type Leg } from "@flexipay/web-lib/contract"

const snapshotLegId = (event: Event): string | null => {
	const value = event.snapshot?.legId
	return typeof value === "string" && value.length > 0 ? value : null
}

/** First matching event's createdAt, or null. */
export function findEventTime(
	events: readonly Event[],
	type: string,
): string | null {
	const found = events.find((event) => event.type === type)
	return found?.createdAt ?? null
}

/**
 * Time for a timeline leg. Always matched on snapshot.legId so a settle step
 * never inherits payment.onchain / payment.paid (or another leg's) timestamp.
 */
export function legEventTime(
	events: readonly Event[],
	leg: Leg,
): string | null {
	if (leg.kind === "settle") {
		const onchain = events.find(
			(event) =>
				event.type === "payment.onchain" && snapshotLegId(event) === leg.id,
		)
		if (onchain) return onchain.createdAt
	}
	const match = events.find((event) => {
		if (event.type !== "leg.succeeded" && event.type !== "leg.failed") {
			return false
		}
		return snapshotLegId(event) === leg.id
	})
	return match?.createdAt ?? null
}

export type PaymentMilestoneTimes = {
	created: string | null
	funded: string | null
	paid: string | null
}

export function paymentMilestoneTimes(
	events: readonly Event[],
): PaymentMilestoneTimes {
	return {
		created: findEventTime(events, "payment.created"),
		funded: findEventTime(events, "payment.funded"),
		paid: findEventTime(events, "payment.paid"),
	}
}
