import {
	assertLegTransition,
	assertPaymentTransition,
	PAYMENT_STATUS_EVENT,
	type LegStatus,
	type PaymentStatus,
} from "@flexipay/domain";
import type { Db } from "../db.ts";
import { newId } from "../ids.ts";

/** Public payment snapshot — never includes claim secrets or seal blobs (CCR-11). */
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
			/** Vault payoutId for settle; provider ref otherwise (CCR-12). */
			externalRef: l.externalRef,
			lockTxRef: l.lockTxRef,
			releaseTxRef: l.releaseTxRef,
			providerId: l.providerId,
			errorCode: l.errorCode,
		})),
		claimLink: payment.claimLink
			? {
					status: payment.claimLink.status,
					expiresAt: payment.claimLink.expiresAt.toISOString(),
					// vaultClaimHashHex is not secret but omit from public event noise; never seal.
				}
			: null,
	};
}

export async function getPaymentView(db: Db, paymentId: string) {
	return paymentSnapshot(db, paymentId);
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
	if (to === "paid") await emitBatchCompletedIfDone(db, paymentId, organizationId);
}

/** `batch.completed` (§9): once, when the last payment of a batch becomes paid. */
async function emitBatchCompletedIfDone(
	db: Db,
	paymentId: string,
	organizationId: string,
): Promise<void> {
	const payment = await db.payment.findUnique({
		where: { id: paymentId },
		select: { batchId: true },
	});
	if (!payment?.batchId) return;
	const siblings = await db.payment.findMany({
		where: { batchId: payment.batchId },
		select: { id: true, status: true },
		orderBy: { createdAt: "asc" },
	});
	if (!siblings.every((p) => p.status === "paid")) return;
	const existing = await db.event.findFirst({
		where: {
			organizationId,
			type: "batch.completed",
			snapshot: { path: ["batchId"], equals: payment.batchId },
		},
	});
	if (existing) return;
	await db.event.create({
		data: {
			id: newId("evt"),
			organizationId,
			type: "batch.completed",
			paymentId: null,
			snapshot: {
				batchId: payment.batchId,
				status: "completed",
				paymentIds: siblings.map((p) => p.id),
			},
		},
	});
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
		lockTxRef?: string | null;
		releaseTxRef?: string | null;
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
			...(extra?.lockTxRef !== undefined ? { lockTxRef: extra.lockTxRef } : {}),
			...(extra?.releaseTxRef !== undefined
				? { releaseTxRef: extra.releaseTxRef }
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
