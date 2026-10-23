import {
	CreateQuoteRequestSchema,
	QuoteSchema,
	buildQuote,
	type CreateQuoteRequest,
	type Quote,
} from "@flexipay/domain";
import { ApiError } from "../errors.ts";
import { persistQuoteRow } from "../serialize.ts";
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
		auth: "api_key",
		body: CreateQuoteRequestSchema,
		success: { status: 201, schema: QuoteSchema },
		handler: async (ctx, { body }) => createQuoteForOrg(ctx, orgOf(ctx).id, body),
	}),
];
