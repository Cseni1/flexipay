import {
	CreateQuoteRequestSchema,
	QuoteSchema,
	buildQuote,
} from "@flexipay/domain";
import { ApiError } from "../errors.ts";
import { persistQuoteRow } from "../serialize.ts";
import { defineRoute, type RouteDef } from "../routes.ts";

const orgOf = (ctx: { org?: { id: string }; runtime?: unknown }) => {
	if (!ctx.org) throw new ApiError(401, "unauthorized", "missing organization");
	return ctx.org;
};

export const quoteRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "post",
		path: "/v1/quotes",
		summary: "Quote with route, fees, FX, validity, alternatives, reasons",
		auth: "api_key",
		body: CreateQuoteRequestSchema,
		success: { status: 201, schema: QuoteSchema },
		handler: async (ctx, { body }) => {
			const org = orgOf(ctx);
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
				data: persistQuoteRow(result.quote, org.id),
			});
			return result.quote;
		},
	}),
];
