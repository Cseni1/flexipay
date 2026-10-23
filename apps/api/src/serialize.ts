import {
	EventSchema,
	LegSchema,
	PaymentDetailSchema,
	PaymentSchema,
	QuoteSchema,
	type Event,
	type Leg,
	type Payment,
	type PaymentDetail,
	type Quote,
} from "@flexipay/domain";
import type { Db } from "./db.ts";

type DbLeg = {
	id: string;
	paymentId: string;
	kind: string;
	rail: string;
	providerId: string;
	amountInValue: string;
	amountInCurrency: string;
	amountOutValue: string;
	amountOutCurrency: string;
	status: string;
	attempt: number;
	externalRef: string | null;
	lockTxRef: string | null;
	releaseTxRef: string | null;
	errorCode: string | null;
	errorMessage: string | null;
	reversalOf: string | null;
	simulated: boolean;
};

export function toApiLeg(l: DbLeg): Leg {
	return LegSchema.parse({
		id: l.id,
		paymentId: l.paymentId,
		kind: l.kind,
		rail: l.rail,
		providerId: l.providerId,
		amountIn: { amount: l.amountInValue, currency: l.amountInCurrency },
		amountOut: { amount: l.amountOutValue, currency: l.amountOutCurrency },
		status: l.status,
		attempt: l.attempt,
		externalRef: l.externalRef,
		lockTxRef: l.lockTxRef,
		releaseTxRef: l.releaseTxRef,
		error:
			l.errorCode && l.errorMessage
				? { code: l.errorCode, message: l.errorMessage }
				: null,
		reversalOf: l.reversalOf,
		simulated: l.simulated,
	});
}

export function toApiPayment(
	row: {
		id: string;
		organizationId: string;
		quoteId: string;
		recipientId: string;
		externalId: string | null;
		delivery: string;
		profile: string;
		reference: string | null;
		status: string;
		batchId: string | null;
		createdAt: Date;
		updatedAt: Date;
		legs: DbLeg[];
		claimLink: { expiresAt: Date } | null;
	},
	claimHandle: { url: string; expiresAt: string } | null,
): Payment {
	return PaymentSchema.parse({
		id: row.id,
		organizationId: row.organizationId,
		quoteId: row.quoteId,
		recipientId: row.recipientId,
		externalId: row.externalId,
		delivery: row.delivery,
		profile: row.profile,
		reference: row.reference,
		status: row.status,
		batchId: row.batchId,
		legs: row.legs.map(toApiLeg),
		claimLink: claimHandle,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	});
}

export async function loadPaymentApi(
	db: Db,
	paymentId: string,
	organizationId: string,
	opts?: { claimToken?: string; apiPublicBase?: string },
): Promise<Payment> {
	const row = await db.payment.findFirst({
		where: { id: paymentId, organizationId },
		include: { legs: { orderBy: { position: "asc" } }, claimLink: true },
	});
	if (!row) throw new Error("payment not found");
	let claimHandle: { url: string; expiresAt: string } | null = null;
	if (row.claimLink && opts?.claimToken) {
		const base = opts.apiPublicBase ?? "";
		claimHandle = {
			url: `${base}/v1/claims/${opts.claimToken}`,
			expiresAt: row.claimLink.expiresAt.toISOString(),
		};
	} else if (row.claimLink) {
		// Token not re-issued on GET — url omitted pattern: still require ClaimLinkHandle or null.
		// Contract: claimLink on Payment is handle with url; after create only once.
		// On GET without token, return null for claimLink (token already delivered).
		claimHandle = null;
	}
	return toApiPayment(row, claimHandle);
}

export async function loadPaymentDetail(
	db: Db,
	paymentId: string,
	organizationId: string,
): Promise<PaymentDetail> {
	const payment = await loadPaymentApi(db, paymentId, organizationId);
	const events = await db.event.findMany({
		where: { paymentId, organizationId },
		orderBy: { createdAt: "asc" },
	});
	return PaymentDetailSchema.parse({
		...payment,
		events: events.map((e) =>
			EventSchema.parse({
				id: e.id,
				type: e.type,
				createdAt: e.createdAt.toISOString(),
				paymentId: e.paymentId,
				snapshot: e.snapshot as Record<string, unknown>,
			}),
		),
	});
}

export function persistQuoteRow(
	quote: Quote,
	organizationId: string,
): {
	id: string;
	organizationId: string;
	source: object;
	destination: object;
	amountSide: string;
	amountValue: string;
	amountCurrency: string;
	route: object;
	fees: object;
	fxRate: string | null;
	expectedReceive: string;
	receiveCurrency: string;
	priceRiskBearer: string;
	policy: string;
	validUntil: Date;
	alternatives: object;
	reasons: object;
	feeMode: string | null;
	simulated: boolean;
} {
	const q = QuoteSchema.parse(quote);
	return {
		id: q.id,
		organizationId,
		source: q.source,
		destination: q.destination,
		amountSide: q.amount.side,
		amountValue: q.amount.value.amount,
		amountCurrency: q.amount.value.currency,
		route: q.route,
		fees: q.fees,
		fxRate: q.fxRate,
		expectedReceive: q.expectedReceive.amount,
		receiveCurrency: q.expectedReceive.currency,
		priceRiskBearer: q.priceRiskBearer,
		policy: q.policy,
		validUntil: new Date(q.validUntil),
		alternatives: q.alternatives,
		reasons: q.reasons,
		feeMode: q.feeMode,
		simulated: q.simulated,
	};
}

export function toApiEvent(e: {
	id: string;
	type: string;
	createdAt: Date;
	paymentId: string | null;
	snapshot: unknown;
}): Event {
	return EventSchema.parse({
		id: e.id,
		type: e.type,
		createdAt: e.createdAt.toISOString(),
		paymentId: e.paymentId,
		snapshot: e.snapshot as Record<string, unknown>,
	});
}
