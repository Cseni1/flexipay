import {
	assertLegTransition,
	assertPaymentTransition,
	PAYMENT_STATUS_EVENT,
	type LegStatus,
	type PaymentStatus,
} from "@flexipay/domain";
import type { Db } from "../db.ts";
import { newId } from "../ids.ts";

export async function paymentSnapshot(db: Db, paymentId: string) {
	const payment = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
		include: { legs: { orderBy: { position: "asc" } }, claimLink: true },
	});
	return {
		id: payment.id,
		status: payment.status,
		lockAttempt: payment.lockAttempt,
		delivery: payment.delivery,
		legs: payment.legs.map((l) => ({
			id: l.id,
			position: l.position,
			kind: l.kind,
			rail: l.rail,
			status: l.status,
			attempt: l.attempt,
			externalRef: l.externalRef,
			providerId: l.providerId,
			errorCode: l.errorCode,
		})),
		claimLink: payment.claimLink
			? { status: payment.claimLink.status, expiresAt: payment.claimLink.expiresAt.toISOString() }
			: null,
	};
}

export async function transitionPayment(
	db: Db,
	paymentId: string,
	organizationId: string,
	from: PaymentStatus,
	to: PaymentStatus,
	reason?: string,
): Promise<void> {
	assertPaymentTransition(from, to);
	await db.payment.update({
		where: { id: paymentId },
		data: { status: to },
	});
	await db.auditRow.create({
		data: {
			id: newId("aud"),
			paymentId,
			entity: "payment",
			entityId: paymentId,
			fromStatus: from,
			toStatus: to,
			reason: reason ?? null,
		},
	});
	const eventType = PAYMENT_STATUS_EVENT[to];
	if (eventType) {
		const snapshot = await paymentSnapshot(db, paymentId);
		await db.event.create({
			data: {
				id: newId("evt"),
				organizationId,
				type: eventType,
				paymentId,
				snapshot,
			},
		});
	}
}

export async function transitionLeg(
	db: Db,
	paymentId: string,
	legId: string,
	from: LegStatus,
	to: LegStatus,
	reason?: string,
	extra?: {
		externalRef?: string | null;
		errorCode?: string | null;
		errorMessage?: string | null;
		attempt?: number;
	},
): Promise<void> {
	assertLegTransition(from, to);
	await db.leg.update({
		where: { id: legId },
		data: {
			status: to,
			...(extra?.externalRef !== undefined
				? { externalRef: extra.externalRef }
				: {}),
			...(extra?.errorCode !== undefined ? { errorCode: extra.errorCode } : {}),
			...(extra?.errorMessage !== undefined
				? { errorMessage: extra.errorMessage }
				: {}),
			...(extra?.attempt !== undefined ? { attempt: extra.attempt } : {}),
		},
	});
	await db.auditRow.create({
		data: {
			id: newId("aud"),
			paymentId,
			entity: "leg",
			entityId: legId,
			fromStatus: from,
			toStatus: to,
			reason: reason ?? null,
		},
	});
}

export async function emitPaymentEvent(
	db: Db,
	organizationId: string,
	paymentId: string,
	type: string,
	snapshotExtra?: Record<string, unknown>,
): Promise<void> {
	const snapshot = {
		...(await paymentSnapshot(db, paymentId)),
		...snapshotExtra,
	};
	await db.event.create({
		data: {
			id: newId("evt"),
			organizationId,
			type,
			paymentId,
			snapshot,
		},
	});
}
