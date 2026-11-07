import { Keypair } from "@solana/web3.js";
import {
	isPaid,
	isSolanaSettleRail,
	solanaRailForAsset,
	type LegKind,
	type LegStatus,
	type PaymentStatus,
} from "@flexipay/domain";
import type { Db } from "../db.ts";
import { newId } from "../ids.ts";
import type { OrchestratorAdapters } from "./types.ts";
import {
	emitPaymentEvent,
	transitionLeg,
	transitionPayment,
} from "./persist.ts";

/**
 * CCR-24 + Lane B: accept a Solana destination (USDC or, CCR-26, TGBP) without vault release.
 * Binds the accepted endpoint id and a Solana Pay reference on the claim (F4/F5).
 * If the settle leg still holds a Stellar/mock vault lock, refund it and switch
 * the settle rail to the payment's Solana rail (`solana_usdc` or `solana_tgbp`) so funds are not double-locked (F9).
 */
export async function acceptSolanaClaimDestination(
	db: Db,
	paymentId: string,
	opts: {
		address: string;
		currency: string;
		adapters?: OrchestratorAdapters;
	},
): Promise<{ status: PaymentStatus; endpointId: string; reference: string }> {
	const payment = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
		include: { claimLink: true, legs: true, quote: true },
	});
	// CCR-26: the payment keeps its own asset; TGBP payments never switch to solana_usdc.
	const solanaRail = solanaRailForAsset(payment.quote.receiveCurrency) ?? "solana_usdc";
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

	// F9: leave no vault lock behind when settling on Solana instead.
	if (settle.externalRef || settle.lockTxRef) {
		if (!opts.adapters) {
			throw new Error(
				"vault lock present: adapters required to refund before Solana settle (F9)",
			);
		}
		if (settle.externalRef) {
			const st = await opts.adapters.settlement.status(settle.externalRef);
			if (st.state === "pending") {
				await opts.adapters.settlement.refund(settle.externalRef);
			}
		}
		await db.leg.update({
			where: { id: settle.id },
			data: {
				rail: solanaRail,
				providerId: solanaRail,
				externalRef: null,
				lockTxRef: null,
				fundTxRef: null,
				fundOpIndex: null,
				fundAmountValue: null,
				fundAmountCurrency: null,
				fundNetwork: "solana",
				fundVaultId: null,
			},
		});
		await emitPaymentEvent(db, payment.organizationId, paymentId, "payment.onchain", {
			phase: "solana_settle_rail",
			detail: `vault_lock_refunded_for_${solanaRail}`,
			legId: settle.id,
		});
	} else if (settle.rail !== solanaRail) {
		await db.leg.update({
			where: { id: settle.id },
			data: {
				rail: solanaRail,
				providerId: solanaRail,
				fundNetwork: "solana",
			},
		});
	}

	const endpointId = newId("end");
	const reference = Keypair.generate().publicKey.toBase58();
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
		data: {
			status: "accepted",
			acceptedEndpointId: endpointId,
			solanaPayReference: reference,
			solanaIntentAt: null,
		},
	});
	await emitPaymentEvent(db, payment.organizationId, paymentId, "claim.accepted", {
		network: "solana",
		endpointId,
		destination: opts.address,
		reference,
	});

	const after = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
	return { status: after.status as PaymentStatus, endpointId, reference };
}

export type SolanaClaimDestination = {
	address: string;
	endpointId: string;
	reference: string;
	intentAt: Date | null;
};

/**
 * F5: read only the endpoint id stored on this claim — never the recipient's latest.
 */
export async function loadSolanaClaimDestination(
	db: Db,
	paymentId: string,
): Promise<SolanaClaimDestination | null> {
	const link = await db.claimLink.findUnique({ where: { paymentId } });
	if (!link?.acceptedEndpointId || !link.solanaPayReference) return null;
	const endpoint = await db.endpoint.findUnique({
		where: { id: link.acceptedEndpointId },
	});
	if (!endpoint || endpoint.network !== "solana") return null;
	const details = endpoint.details as { address?: string };
	if (!details.address) return null;
	return {
		address: details.address,
		endpointId: endpoint.id,
		reference: link.solanaPayReference,
		intentAt: link.solanaIntentAt,
	};
}

/** First intent issuance stamps ClaimLink.solanaIntentAt (F4 age bound). */
export async function ensureSolanaIntentIssuedAt(
	db: Db,
	paymentId: string,
	now: Date = new Date(),
): Promise<Date> {
	const link = await db.claimLink.findUniqueOrThrow({ where: { paymentId } });
	if (link.solanaIntentAt) return link.solanaIntentAt;
	await db.claimLink.update({
		where: { paymentId },
		data: { solanaIntentAt: now },
	});
	return now;
}

type OrderedLeg = {
	kind: string;
	rail: string;
	status: string;
	releaseTxRef: string | null;
	position: number;
};

/**
 * CCR-39: direct delivery with a Solana settle still processing and at least one leg after it.
 */
export function isDirectSolanaSettleWaiting(payment: {
	delivery: string;
	legs: OrderedLeg[];
}): boolean {
	if (payment.delivery !== "direct") return false;
	const legs = [...payment.legs].sort((a, b) => a.position - b.position);
	const settleIdx = legs.findIndex((l) => l.kind === "settle");
	if (settleIdx < 0 || settleIdx >= legs.length - 1) return false;
	const settle = legs[settleIdx]!;
	return (
		isSolanaSettleRail(settle.rail) &&
		settle.status === "processing" &&
		!settle.releaseTxRef
	);
}

/** CCR-39: generate once + stamp intent time on Payment (not ClaimLink). */
export async function ensureDirectSolanaIntentBinding(
	db: Db,
	paymentId: string,
	now: Date = new Date(),
): Promise<{ reference: string; intentAt: Date }> {
	const payment = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
		select: { solanaPayReference: true, solanaIntentAt: true },
	});
	let reference = payment.solanaPayReference;
	if (!reference) {
		reference = Keypair.generate().publicKey.toBase58();
		await db.payment.update({
			where: { id: paymentId },
			data: { solanaPayReference: reference },
		});
	}
	if (payment.solanaIntentAt) {
		return { reference, intentAt: payment.solanaIntentAt };
	}
	await db.payment.update({
		where: { id: paymentId },
		data: { solanaIntentAt: now },
	});
	return { reference, intentAt: now };
}

export class ReusedSolanaSignatureError extends Error {
	readonly existingPaymentId: string;
	constructor(existingPaymentId: string) {
		super(`Solana signature already used on payment ${existingPaymentId}`);
		this.name = "ReusedSolanaSignatureError";
		this.existingPaymentId = existingPaymentId;
	}
}

/**
 * Persist verified Solana signature as settle release evidence and mark payment paid.
 * F4: refuse a signature already stored on any payment (unique releaseTxRef).
 */
export async function completeSolanaTransferSettle(
	db: Db,
	paymentId: string,
	opts: { signature: string; destination: string; payer?: string | null },
): Promise<{ status: PaymentStatus }> {
	const payment = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
		include: {
			legs: { orderBy: { position: "asc" } },
			claimLink: true,
			quote: true,
		},
	});
	const settle = payment.legs.find((l) => l.kind === "settle");
	if (!settle) throw new Error("settle leg missing");
	const solanaRail = solanaRailForAsset(payment.quote.receiveCurrency) ?? "solana_usdc";

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
	const directSettle = isDirectSolanaSettleWaiting({
		delivery: payment.delivery,
		legs: payment.legs.map((l) => ({
			kind: l.kind,
			rail: l.rail,
			status: l.status,
			releaseTxRef: l.releaseTxRef,
			position: l.position,
		})),
	});
	// CCR-39: direct treasury settle has no claim destination; claim-link path unchanged.
	if (!directSettle && payment.claimLink?.status !== "accepted") {
		throw new Error("Solana destination must be accepted on the claim first");
	}

	const reused = await db.leg.findFirst({
		where: {
			releaseTxRef: opts.signature,
			NOT: { paymentId },
		},
		select: { paymentId: true },
	});
	if (reused) {
		throw new ReusedSolanaSignatureError(reused.paymentId);
	}

	try {
		await db.leg.update({
			where: { id: settle.id },
			data: {
				releaseTxRef: opts.signature,
				fundNetwork: "solana",
				rail: isSolanaSettleRail(settle.rail) ? settle.rail : solanaRail,
				providerId: isSolanaSettleRail(settle.providerId)
					? settle.providerId
					: solanaRail,
			},
		});
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		if (/Leg_releaseTxRef_key|Unique constraint/i.test(message)) {
			throw new ReusedSolanaSignatureError("unknown");
		}
		throw cause;
	}

	await emitPaymentEvent(db, payment.organizationId, paymentId, "payment.onchain", {
		phase: "solana_transfer",
		releaseTxRef: opts.signature,
		network: "solana",
		destination: opts.destination,
		...(opts.payer ? { payer: opts.payer } : {}),
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
