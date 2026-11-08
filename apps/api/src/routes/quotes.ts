import {
	CreateQuoteRequestSchema,
	QuoteSchema,
	buildQuote,
	type CreateQuoteRequest,
	type Quote,
} from "@flexipay/domain";
import { ApiError } from "../errors.ts";
import { livePaymentsPaused } from "../live/kill-switch.ts";
import { assertIndividualSenderLimit } from "../live/limits.ts";
import { persistQuoteRow, quoteFromRow } from "../serialize.ts";
import { defineRoute, type Ctx, type RouteDef } from "../routes.ts";

const orgOf = (ctx: { org?: { id: string }; runtime?: unknown }) => {
	if (!ctx.org) throw new ApiError(401, "unauthorized", "missing organization");
	return ctx.org;
};

/**
 * Prices and persists one quote. POST /v1/quotes and POST /v1/batches (per row) both go
 * through here, so there is a single pricing path (CCR-18: no second engine).
 */
export async function createQuoteForOrg(
	ctx: Ctx,
	orgId: string,
	body: CreateQuoteRequest,
): Promise<Quote> {
	if (!ctx.runtime) throw new ApiError(500, "internal_error", "runtime not configured");
	if (livePaymentsPaused()) {
		throw new ApiError(
			503,
			"live_payments_paused",
			"Live payments are paused. Reads, refunds and status checks still work.",
		);
	}
	const vaultFeeBps = await ctx.runtime.settlement.feeBps();
	const result = await buildQuote(body, {
		config: ctx.config,
		getProvider: ctx.runtime.getProvider,
		vaultFeeBps,
		settlementSimulated: ctx.runtime.settlementSimulated,
		now: ctx.runtime.now,
	});
	if (!result.ok) {
		throw new ApiError(422, "not_eligible", "No eligible route", {
			reasons: result.reasons,
		});
	}
	const send =
		result.quote.amount.side === "send"
			? result.quote.amount.value
			: result.quote.route[0]!.amountIn;
	await assertIndividualSenderLimit(
		ctx.db,
		ctx.config,
		orgId,
		send,
		ctx.runtime.now(),
	);
	await ctx.db.quote.create({
		data: persistQuoteRow(result.quote, orgId),
	});
	return result.quote;
}

export const quoteRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "post",
		path: "/v1/quotes",
		summary: "Quote with route, fees, FX, validity, alternatives, reasons",
		auth: "customer",
		body: CreateQuoteRequestSchema,
		success: { status: 201, schema: QuoteSchema },
		handler: async (ctx, { body }) => createQuoteForOrg(ctx, orgOf(ctx).id, body),
	}),
	defineRoute({
		method: "get",
		path: "/v1/quotes/{id}",
		summary: "A quote this organization created, as it was priced (route, alternatives, reasons)",
		auth: "customer",
		success: { status: 200, schema: QuoteSchema },
		handler: async (ctx, { params }) => {
			const row = await ctx.db.quote.findFirst({
				where: { id: params.id!, organizationId: orgOf(ctx).id },
			});
			if (!row) throw new ApiError(404, "not_found", "Quote not found");
			return quoteFromRow(row);
		},
	}),
];
