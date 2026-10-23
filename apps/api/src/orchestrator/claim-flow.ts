import { type LegKind, type PaymentStatus } from "@flexipay/domain";
import type { Db } from "../db.ts";
import { continueAfterClaimAccept } from "./run.ts";
import {
	emitPaymentEvent,
	transitionLeg,
	transitionPayment,
} from "./persist.ts";
import type { OrchestratorAdapters } from "./types.ts";

// Claim-link paths that are not the crypto release: fiat accept (CCR-17) and lazy expiry
// (ARCHITECTURE §7, evaluated on read and on use against the API clock).

export class ClaimNotWaitingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ClaimNotWaitingError";
	}
}

/**
 * Fiat claim accept: the payout leg has been waiting `pending` since funding. Marks the claim
 * accepted, then runs the payout with the recipient's endpoint (retry once, refund on a second
 * failure, exactly as for a direct payment). Accepted does not mean paid.
 */
export async function acceptFiatClaim(
	db: Db,
	paymentId: string,
	adapters: OrchestratorAdapters,
	opts: { endpointId: string },
): Promise<{ status: PaymentStatus }> {
	const payment = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
		include: { legs: { orderBy: { position: "asc" } }, claimLink: true },
	});
	const payout = payment.legs.find((l) => l.kind === ("payout" satisfies LegKind));
	if (
		payment.delivery !== "claim_link" ||
		payment.status !== "processing" ||
		!payout ||
		payout.status !== "pending" ||
		payment.claimLink?.status !== "open"
	) {
		throw new ClaimNotWaitingError("payout is not waiting for this claim");
	}
	const earlier = payment.legs.filter((l) => l.position < payout.position);
	if (earlier.some((l) => l.status !== "succeeded")) {
		throw new ClaimNotWaitingError("earlier legs have not succeeded");
	}

	await db.claimLink.update({ where: { paymentId }, data: { status: "accepted" } });
	await emitPaymentEvent(db, payment.organizationId, paymentId, "claim.accepted", {
		endpointId: opts.endpointId,
	});
	return continueAfterClaimAccept(db, paymentId, adapters, opts.endpointId);
}

/**
 * Lazy claim expiry. Returns true when the link was open and past `now` (the claim is closed).
 * A funded claim-wait payment is expired and its vault lock refunded; earlier legs are reversed.
 * Never marks `refunded` unless the vault refund and every reversal succeeded.
 */
export async function expireClaimIfDue(
	db: Db,
	paymentId: string,
	adapters: OrchestratorAdapters,
	now: Date,
): Promise<boolean> {
	const payment = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
		include: { legs: { orderBy: { position: "asc" } }, claimLink: true },
	});
	const link = payment.claimLink;
	if (
		payment.delivery !== "claim_link" ||
		!link ||
		link.status !== "open" ||
		link.expiresAt.getTime() > now.getTime()
	) {
		return false;
	}

	await db.claimLink.update({ where: { paymentId }, data: { status: "expired" } });
	const status = payment.status as PaymentStatus;

	if (status === "quoted" || status === "awaiting_funding") {
		await transitionPayment(db, paymentId, payment.organizationId, status, "expired", "claim expired");
		return true;
	}
	if (status !== "processing") return true;

	// A crypto claim waits on a `processing` settle leg: it will never be released now.
	const waiting = payment.legs.find(
		(l) => l.kind === "settle" && l.status === "processing",
	);
	if (waiting) {
		await transitionLeg(db, paymentId, waiting.id, "processing", "failed", "claim expired", {
			errorCode: "claim_expired",
			errorMessage: "claim link expired before it was accepted",
		});
	}
	await transitionPayment(db, paymentId, payment.organizationId, "processing", "expired", "claim expired");
	await transitionPayment(db, paymentId, payment.organizationId, "expired", "refunding", "claim expired");

	const settle = payment.legs.find((l) => l.kind === "settle" && l.externalRef);
	if (settle?.externalRef) {
		try {
			const vault = await adapters.settlement.status(settle.externalRef);
			if (vault.state === "pending") {
				const refunded = await adapters.settlement.refund(settle.externalRef);
				await db.leg.update({
					where: { id: settle.id },
					data: { releaseTxRef: refunded.txRef },
				});
				await emitPaymentEvent(db, payment.organizationId, paymentId, "payment.onchain", {
					phase: "refund",
					payoutId: settle.externalRef,
					releaseTxRef: refunded.txRef,
				});
			}
		} catch (e) {
			const reason = e instanceof Error ? e.message : "refund failed";
			await db.leg.update({
				where: { id: settle.id },
				data: {
					errorCode: settle.errorCode ?? "refund_failed",
					errorMessage: [settle.errorMessage, `refund failed: ${reason}`]
						.filter(Boolean)
						.join("; "),
				},
			});
			await transitionPayment(db, paymentId, payment.organizationId, "refunding", "failed", reason);
			return true;
		}
	}

	const reversible = [...payment.legs]
		.filter(
			(l) =>
				(l.kind === "collect" || l.kind === "convert") &&
				l.status === "succeeded" &&
				l.externalRef,
		)
		.reverse();
	for (const leg of reversible) {
		const provider = adapters.getProvider(leg.providerId);
		if (!provider || !leg.externalRef) continue;
		try {
			await transitionLeg(db, paymentId, leg.id, "succeeded", "reversing");
			await provider.reverse(leg.externalRef);
			await transitionLeg(db, paymentId, leg.id, "reversing", "reversed");
		} catch (e) {
			await transitionPayment(
				db,
				paymentId,
				payment.organizationId,
				"refunding",
				"failed",
				e instanceof Error ? e.message : "reverse failed",
			);
			return true;
		}
	}
	await transitionPayment(db, paymentId, payment.organizationId, "refunding", "refunded", "claim expired");
	return true;
}
