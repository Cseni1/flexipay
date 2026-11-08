import { randomBytes } from "node:crypto";
import {
	FeeBreakdownSchema,
	PlannedLegSchema,
	SENDER_WALLET_BLINDPAY_RAIL,
	type FeeMode,
	type PlannedLeg,
} from "@flexipay/domain";
import { z } from "zod";
import type { Db } from "../db.ts";
import { newId, sha256Hex } from "../ids.ts";
import { emitPaymentEvent } from "./persist.ts";
import type { CreatePaymentFromQuoteInput } from "./types.ts";

const RouteSchema = z.array(PlannedLegSchema).min(1);

/**
 * Production payment create (CCR-13): copy frozen PlannedLeg amounts from the Quote.
 * Does not re-price. Stale quote → throw (CC3 maps to 422).
 */
/**
 * A claim link is an invitation the receiver opens later, so it must outlive the short-lived
 * quote it was created from (quotes last about two minutes). The link stays valid for at least
 * this long; a quote that is valid for longer keeps its own deadline.
 */
export const CLAIM_LINK_MIN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export async function createPaymentFromQuote(
	db: Db,
	input: CreatePaymentFromQuoteInput,
): Promise<{ paymentId: string; claimToken?: string }> {
	const quote = await db.quote.findUniqueOrThrow({
		where: { id: input.quoteId },
	});
	if (quote.organizationId !== input.organizationId) {
		throw new Error("quote does not belong to organization");
	}
	if (quote.validUntil.getTime() <= (input.now ?? new Date()).getTime()) {
		throw new Error("quote expired");
	}

	const route = RouteSchema.parse(quote.route);
	const fees = FeeBreakdownSchema.parse(quote.fees);
	const feeMode = (quote.feeMode as FeeMode | null) ?? null;
	const senderWallet = route.some((l) => l.rail === SENDER_WALLET_BLINDPAY_RAIL);
	if (route.some((l) => l.kind === "settle") && feeMode === null && !senderWallet) {
		throw new Error(
			"quote.feeMode is required when the route includes settle (CCR-8/CCR-13)",
		);
	}
	if (senderWallet && input.delivery !== "direct") {
		throw new Error(
			"sender_wallet_blindpay requires delivery direct",
		);
	}
	if (senderWallet && !input.endpointId) {
		throw new Error("endpoint is required for a sender-wallet BlindPay payout");
	}
	void fees;

	const recipient = await db.recipient.findUniqueOrThrow({
		where: { id: input.recipientId },
	});
	if (recipient.organizationId !== input.organizationId) {
		throw new Error("recipient does not belong to organization");
	}

	// CCR-32: keep the chosen endpoint so a batch payout can load its bank details later.
	let endpointId: string | null = null;
	if (input.endpointId) {
		const endpoint = await db.endpoint.findFirst({
			where: { id: input.endpointId, organizationId: input.organizationId },
		});
		if (!endpoint) throw new Error("endpoint does not belong to organization");
		if (endpoint.recipientId !== input.recipientId) {
			throw new Error("endpoint belongs to a different recipient");
		}
		const dest = quote.destination as {
			type: string;
			country: string;
			currency: string;
		};
		if (
			endpoint.type !== dest.type ||
			(endpoint.country ?? "") !== dest.country ||
			endpoint.currency !== dest.currency
		) {
			throw new Error("endpoint does not match the quote destination");
		}
		endpointId = endpoint.id;
	}

	if (input.externalId) {
		const dup = await db.payment.findUnique({
			where: {
				organizationId_externalId: {
					organizationId: input.organizationId,
					externalId: input.externalId,
				},
			},
		});
		if (dup) {
			throw new Error("duplicate externalId");
		}
	}

	const paymentId = newId("pay");
	await db.payment.create({
		data: {
			id: paymentId,
			organizationId: input.organizationId,
			quoteId: input.quoteId,
			recipientId: input.recipientId,
			endpointId,
			externalId: input.externalId ?? null,
			batchId: input.batchId ?? null,
			delivery: input.delivery,
			profile: input.profile,
			reference: input.reference ?? null,
			status: "awaiting_funding",
			lockAttempt: 0,
			legs: {
				create: route.map((leg: PlannedLeg, position: number) => ({
					id: newId("leg"),
					position,
					kind: leg.kind,
					rail: leg.rail,
					providerId: leg.providerId,
					amountInValue: leg.amountIn.amount,
					amountInCurrency: leg.amountIn.currency,
					amountOutValue: leg.amountOut.amount,
					amountOutCurrency: leg.amountOut.currency,
					status: "pending",
					attempt: 1,
					simulated: leg.simulated,
				})),
			},
		},
	});

	await db.auditRow.create({
		data: {
			id: newId("aud"),
			paymentId,
			entity: "payment",
			entityId: paymentId,
			fromStatus: null,
			toStatus: "awaiting_funding",
			reason: "createPaymentFromQuote",
		},
	});
	await emitPaymentEvent(db, input.organizationId, paymentId, "payment.created");

	let claimToken: string | undefined;
	if (input.delivery === "claim_link") {
		claimToken = randomBytes(24).toString("hex");
		await db.claimLink.create({
			data: {
				paymentId,
				tokenHash: sha256Hex(claimToken),
				expiresAt: new Date(
					Math.max(
						quote.validUntil.getTime(),
						(input.now ?? new Date()).getTime() + CLAIM_LINK_MIN_LIFETIME_MS,
					),
				),
				status: "open",
			},
		});
		await emitPaymentEvent(db, input.organizationId, paymentId, "claim.opened", {
			tokenIssued: true,
		});
	}

	return { paymentId, claimToken };
}

/** True when the route ends at settle (crypto claim-wait); no payout leg. */
export function isClaimWaitRoute(legs: { kind: string }[]): boolean {
	return legs.some((l) => l.kind === "settle") && !legs.some((l) => l.kind === "payout");
}
