import {
	isPaid,
	type LegKind,
	type LegStatus,
	type PaymentStatus,
} from "@flexipay/domain";
import type { Db } from "../db.ts";
import { newId } from "../ids.ts";
import {
	emitPaymentEvent,
	transitionLeg,
	transitionPayment,
} from "./persist.ts";

/**
 * CCR-24: accept a Solana USDC destination without vault release.
 * Claim becomes accepted; payment stays processing until confirmSolanaTransfer.
 */
export async function acceptSolanaClaimDestination(
	db: Db,
	paymentId: string,
	opts: {
		address: string;
		currency: string;
	},
): Promise<{ status: PaymentStatus; endpointId: string }> {
	const payment = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
		include: { claimLink: true, legs: true },
	});
	if (!payment.claimLink || payment.claimLink.status !== "open") {
		throw new Error("claim is not open");
	}
	if (payment.status !== "processing") {
		throw new Error(
			`solana claim accept requires processing, got ${payment.status}`,
		);
	}
	const settle = payment.legs.find((l) => l.kind === "settle");
	if (!settle || settle.status !== "processing") {
		throw new Error("settle leg is not waiting for Solana transfer evidence");
	}
	if (settle.releaseTxRef) {
		throw new Error("settle already has release evidence");
	}

	const endpointId = newId("end");
	await db.endpoint.create({
		data: {
			id: endpointId,
			organizationId: payment.organizationId,
			recipientId: payment.recipientId,
			type: "crypto_wallet",
			country: "",
			currency: opts.currency,
			network: "solana",
			details: { address: opts.address },
			simulated: true,
		},
	});

	await db.claimLink.update({
		where: { paymentId },
		data: { status: "accepted" },
	});
	await emitPaymentEvent(db, payment.organizationId, paymentId, "claim.accepted", {
		network: "solana",
		endpointId,
		destination: opts.address,
	});

	const after = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
	return { status: after.status as PaymentStatus, endpointId };
}

export async function loadSolanaClaimDestination(
	db: Db,
	paymentId: string,
): Promise<string | null> {
	const payment = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
	});
	const endpoint = await db.endpoint.findFirst({
		where: {
			organizationId: payment.organizationId,
			recipientId: payment.recipientId,
			network: "solana",
			type: "crypto_wallet",
		},
		orderBy: { createdAt: "desc" },
	});
	if (!endpoint) return null;
	const details = endpoint.details as { address?: string };
	return details.address ?? null;
}

/**
 * Persist verified Solana signature as settle release evidence and mark payment paid.
 * Mirrors recordPasskeyClaimRelease: evidence first, PAID only after settle succeeds.
 */
export async function completeSolanaTransferSettle(
	db: Db,
	paymentId: string,
	opts: { signature: string; destination: string },
): Promise<{ status: PaymentStatus }> {
	const payment = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
		include: { legs: { orderBy: { position: "asc" } }, claimLink: true },
	});
	const settle = payment.legs.find((l) => l.kind === "settle");
	if (!settle) throw new Error("settle leg missing");

	if (settle.releaseTxRef) {
		if (settle.releaseTxRef !== opts.signature) {
			throw new DuplicateSolanaEvidenceError(settle.releaseTxRef);
		}
		const after = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
		return { status: after.status as PaymentStatus };
	}

	if (payment.status !== "processing" || settle.status !== "processing") {
		throw new Error("settle leg is not waiting for Solana confirmation");
	}
	if (payment.claimLink?.status !== "accepted") {
		throw new Error("Solana destination must be accepted on the claim first");
	}

	await db.leg.update({
		where: { id: settle.id },
		data: {
			releaseTxRef: opts.signature,
			fundNetwork: "solana",
		},
	});
	await emitPaymentEvent(db, payment.organizationId, paymentId, "payment.onchain", {
		phase: "solana_transfer",
		releaseTxRef: opts.signature,
		network: "solana",
		destination: opts.destination,
		legId: settle.id,
	});
	await transitionLeg(db, paymentId, settle.id, "processing", "succeeded");
	await emitPaymentEvent(db, payment.organizationId, paymentId, "leg.succeeded", {
		legId: settle.id,
	});

	const legs = await db.leg.findMany({
		where: { paymentId },
		orderBy: { position: "asc" },
	});
	const legStates = legs.map((l) => ({
		kind: l.kind as LegKind,
		status: l.status as LegStatus,
	}));
	if (isPaid(legStates)) {
		await transitionPayment(
			db,
			paymentId,
			payment.organizationId,
			"processing",
			"paid",
		);
	}

	const after = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
	return { status: after.status as PaymentStatus };
}

export class DuplicateSolanaEvidenceError extends Error {
	readonly existingSignature: string;
	constructor(existingSignature: string) {
		super("payment already has different Solana release evidence");
		this.name = "DuplicateSolanaEvidenceError";
		this.existingSignature = existingSignature;
	}
}
