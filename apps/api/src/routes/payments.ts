import { VaultTxFeeError } from "@flexipay/adapter-stellar";
import {
	CreatePaymentRequestSchema,
	PaymentDetailSchema,
	PaymentListResponseSchema,
	PaymentSchema,
} from "@flexipay/domain";
import { ApiError } from "../errors.ts";
import {
	cancelPayment,
	createPaymentFromQuote,
	FeeDriftError,
	fundAndRun,
} from "../orchestrator/index.ts";
import { defineRoute, type RouteDef } from "../routes.ts";
import { loadPaymentApi, loadPaymentDetail } from "../serialize.ts";

const orgOf = (ctx: { org?: { id: string } }) => {
	if (!ctx.org) throw new ApiError(401, "unauthorized", "missing organization");
	return ctx.org;
};

function mapCreateError(e: unknown): never {
	const msg = e instanceof Error ? e.message : "create failed";
	if (/expired/i.test(msg)) throw new ApiError(422, "quote_expired", msg);
	if (/duplicate externalId/i.test(msg)) {
		throw new ApiError(409, "duplicate_external_id", msg);
	}
	if (/feeMode/i.test(msg)) throw new ApiError(422, "invalid_quote", msg);
	throw new ApiError(400, "bad_request", msg);
}

export const paymentRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "post",
		path: "/v1/payments",
		summary: "Create a payment from a valid quote (direct or claim link)",
		auth: "api_key",
		body: CreatePaymentRequestSchema,
		success: { status: 201, schema: PaymentSchema },
		handler: async (ctx, { body }) => {
			const org = orgOf(ctx);
			let created: { paymentId: string; claimToken?: string };
			try {
				created = await createPaymentFromQuote(ctx.db, {
					organizationId: org.id,
					recipientId: body.recipientId,
					quoteId: body.quoteId,
					delivery: body.delivery,
					profile: body.profile,
					externalId: body.externalId,
					reference: body.reference,
					now: ctx.runtime?.now(),
				});
			} catch (e) {
				mapCreateError(e);
			}
			return loadPaymentApi(ctx.db, created.paymentId, org.id, {
				claimToken: created.claimToken,
				apiPublicBase: ctx.runtime?.apiPublicBase,
			});
		},
	}),
	defineRoute({
		method: "get",
		path: "/v1/payments",
		summary: "List payments",
		auth: "api_key",
		success: { status: 200, schema: PaymentListResponseSchema },
		handler: async (ctx) => {
			const org = orgOf(ctx);
			const rows = await ctx.db.payment.findMany({
				where: { organizationId: org.id },
				orderBy: { createdAt: "desc" },
				include: { legs: { orderBy: { position: "asc" } }, claimLink: true },
			});
			const payments = [];
			for (const row of rows) {
				payments.push(await loadPaymentApi(ctx.db, row.id, org.id));
			}
			return { payments };
		},
	}),
	defineRoute({
		method: "get",
		path: "/v1/payments/{id}",
		summary: "Payment with legs and events",
		auth: "api_key",
		success: { status: 200, schema: PaymentDetailSchema },
		handler: async (ctx, { params }) => {
			const org = orgOf(ctx);
			try {
				return await loadPaymentDetail(ctx.db, params.id!, org.id);
			} catch {
				throw new ApiError(404, "not_found", "Payment not found");
			}
		},
	}),
	defineRoute({
		method: "post",
		path: "/v1/payments/{id}/fund",
		summary: "Mark funded (simulated collection); runs the legs",
		auth: "api_key",
		success: { status: 200, schema: PaymentSchema },
		handler: async (ctx, { params }) => {
			const org = orgOf(ctx);
			if (!ctx.runtime) throw new ApiError(500, "internal_error", "runtime not configured");
			const payment = await ctx.db.payment.findFirst({
				where: { id: params.id, organizationId: org.id },
			});
			if (!payment) throw new ApiError(404, "not_found", "Payment not found");
			try {
				await fundAndRun(ctx.db, payment.id, {
					getProvider: ctx.runtime.getProvider,
					settlement: ctx.runtime.settlement,
					vaultPayer: ctx.runtime.vaultPayer,
					now: ctx.runtime.now,
					claimSealKey: ctx.runtime.claimSealKey,
					defaultClaimDestination:
						process.env.FP_RECIPIENT_A_ADDRESS ?? ctx.runtime.vaultPayer,
				});
			} catch (e) {
				const msg = e instanceof Error ? e.message : "fund failed";
				// CCR-15: the drifted lock was failed and refunded; the payment is never paid.
				if (e instanceof FeeDriftError) throw new ApiError(409, "fee_drift", msg);
				// CCR-23: preserve VaultTxFeeError name + reason (API shape finalized in review).
				if (e instanceof VaultTxFeeError) {
					throw new ApiError(409, e.reason, e.message, {
						name: e.name,
						reason: e.reason,
						inclusionFee: e.inclusionFee?.toString(),
						resourceFee: e.resourceFee?.toString(),
						totalFee: e.totalFee?.toString(),
						ceiling: e.ceiling === null ? null : e.ceiling?.toString(),
					});
				}
				throw new ApiError(409, "invalid_state", msg);
			}
			return loadPaymentApi(ctx.db, payment.id, org.id);
		},
	}),
	defineRoute({
		method: "post",
		path: "/v1/payments/{id}/cancel",
		summary: "Cancel before processing",
		auth: "api_key",
		success: { status: 200, schema: PaymentSchema },
		handler: async (ctx, { params }) => {
			const org = orgOf(ctx);
			const payment = await ctx.db.payment.findFirst({
				where: { id: params.id, organizationId: org.id },
			});
			if (!payment) throw new ApiError(404, "not_found", "Payment not found");
			try {
				await cancelPayment(ctx.db, payment.id);
			} catch (e) {
				const msg = e instanceof Error ? e.message : "cancel failed";
				throw new ApiError(409, "invalid_state", msg);
			}
			return loadPaymentApi(ctx.db, payment.id, org.id);
		},
	}),
];
