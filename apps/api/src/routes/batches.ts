import {
	BatchSchema,
	CreateBatchRequestSchema,
	type Batch,
	type BatchStatus,
	type CreateQuoteRequest,
} from "@flexipay/domain";
import type { Db } from "../db.ts";
import { ApiError } from "../errors.ts";
import { newId } from "../ids.ts";
import { createPaymentFromQuote } from "../orchestrator/index.ts";
import { defineRoute, type RouteDef } from "../routes.ts";
import { createQuoteForOrg } from "./quotes.ts";

const orgOf = (ctx: { org?: { id: string } }) => {
	if (!ctx.org) throw new ApiError(401, "unauthorized", "missing organization");
	return ctx.org;
};

/**
 * CCR-18 does not carry a funding source on a batch row. Rows are quoted from the same
 * funding source the demo uses for every quote (a US bank account in USD), as a send-side
 * amount. A different source needs a contract change, not a guess here.
 */
const BATCH_SOURCE = { type: "bank_account", currency: "USD", country: "US" } as const;

const TERMINAL = new Set(["paid", "failed", "refunded", "cancelled", "expired"]);

/**
 * `status` is derived from the batch's payments (ARCHITECTURE §6.7):
 * open: nothing funded yet; completed: all paid; failed: all settled and at least one did not
 * end paid; processing: anything else.
 */
export function deriveBatchStatus(paymentStatuses: string[]): BatchStatus {
	if (paymentStatuses.length === 0) return "open";
	if (paymentStatuses.every((s) => s === "paid")) return "completed";
	if (paymentStatuses.every((s) => TERMINAL.has(s))) return "failed";
	if (paymentStatuses.every((s) => s === "quoted" || s === "awaiting_funding")) return "open";
	return "processing";
}

export async function loadBatch(db: Db, batchId: string, organizationId: string): Promise<Batch> {
	const batch = await db.batch.findFirst({
		where: { id: batchId, organizationId },
		include: {
			payments: { select: { id: true, status: true }, orderBy: { createdAt: "asc" } },
		},
	});
	if (!batch) throw new ApiError(404, "not_found", "Batch not found");
	return BatchSchema.parse({
		id: batch.id,
		organizationId: batch.organizationId,
		status: deriveBatchStatus(batch.payments.map((p) => p.status)),
		paymentIds: batch.payments.map((p) => p.id),
		totals: { count: batch.payments.length },
		createdAt: batch.createdAt.toISOString(),
	});
}

export const batchRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "post",
		path: "/v1/batches",
		summary: "Create a JSON batch: one quote and one payment per row",
		auth: "api_key",
		body: CreateBatchRequestSchema,
		success: { status: 201, schema: BatchSchema },
		handler: async (ctx, { body }) => {
			const org = orgOf(ctx);
			if (!ctx.runtime) throw new ApiError(500, "internal_error", "runtime not configured");

			// 1. Validate every row before anything is written.
			const externalIds = body.rows.map((r) => r.externalId);
			if (new Set(externalIds).size !== externalIds.length) {
				throw new ApiError(409, "duplicate_external_id", "externalId repeats within the batch");
			}
			const taken = await ctx.db.payment.findFirst({
				where: { organizationId: org.id, externalId: { in: externalIds } },
				select: { externalId: true },
			});
			if (taken) {
				throw new ApiError(409, "duplicate_external_id", `duplicate externalId ${taken.externalId}`);
			}
			const requests: { recipientId: string; request: CreateQuoteRequest }[] = [];
			for (const [index, row] of body.rows.entries()) {
				const recipient = await ctx.db.recipient.findFirst({
					where: { id: row.recipientId, organizationId: org.id },
				});
				if (!recipient) {
					throw new ApiError(404, "not_found", `rows[${index}]: recipient not found`);
				}
				const endpoint = await ctx.db.endpoint.findFirst({
					where: { id: row.endpointId, organizationId: org.id },
				});
				if (!endpoint) {
					throw new ApiError(404, "not_found", `rows[${index}]: endpoint not found`);
				}
				if (endpoint.recipientId !== recipient.id) {
					throw new ApiError(
						422,
						"endpoint_mismatch",
						`rows[${index}]: endpoint belongs to a different recipient`,
					);
				}
				requests.push({
					recipientId: recipient.id,
					request: {
						source: { ...BATCH_SOURCE },
						destination: {
							type: endpoint.type as CreateQuoteRequest["destination"]["type"],
							currency: endpoint.currency,
							country: endpoint.country ?? "",
							recipientKind: recipient.kind as CreateQuoteRequest["destination"]["recipientKind"],
						},
						amount: { side: "send", value: row.amount },
						policy: "cheapest",
						feeMode: body.feeMode,
					},
				});
			}

			// 2. Price every row through the one quote path; any ineligible row rejects the batch.
			const quoteIds: string[] = [];
			for (const [index, item] of requests.entries()) {
				try {
					quoteIds.push((await createQuoteForOrg(ctx, org.id, item.request)).id);
				} catch (e) {
					if (e instanceof ApiError && e.code === "not_eligible") {
						throw new ApiError(422, "not_eligible", `rows[${index}]: no eligible route`, {
							row: index,
							...(e.details as object),
						});
					}
					throw e;
				}
			}

			// 3. One payment per row through the existing create-from-quote path.
			const batchId = newId("bat");
			await ctx.db.batch.create({ data: { id: batchId, organizationId: org.id } });
			for (const [index, row] of body.rows.entries()) {
				try {
					await createPaymentFromQuote(ctx.db, {
						organizationId: org.id,
						recipientId: row.recipientId,
						quoteId: quoteIds[index]!,
						delivery: "direct",
						profile: row.profile,
						externalId: row.externalId,
						batchId,
						now: ctx.runtime.now(),
					});
				} catch (e) {
					const msg = e instanceof Error ? e.message : "create failed";
					throw new ApiError(400, "bad_request", `rows[${index}]: ${msg}`);
				}
			}
			return loadBatch(ctx.db, batchId, org.id);
		},
	}),
	defineRoute({
		method: "get",
		path: "/v1/batches/{id}",
		summary: "Batch with derived status and payment ids",
		auth: "api_key",
		success: { status: 200, schema: BatchSchema },
		handler: async (ctx, { params }) => loadBatch(ctx.db, params.id!, orgOf(ctx).id),
	}),
];
