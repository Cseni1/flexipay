import { z } from "zod";
import {
	SandboxAdvanceTimeRequestSchema,
	SandboxAdvanceTimeResponseSchema,
	SandboxFailNextRequestSchema,
	SandboxProviderHealthRequestSchema,
	SandboxResetRequestSchema,
} from "@flexipay/domain";
import { ApiError } from "../errors.ts";
import { defineRoute, type RouteDef } from "../routes.ts";

/** Empty JSON body — sandbox success schemas are not contracted on main (A0 stubs). */
const EmptyOk = z.object({}).strict();

const orgOf = (ctx: { org?: { id: string } }) => {
	if (!ctx.org) throw new ApiError(401, "unauthorized", "missing organization");
	return ctx.org;
};

export const sandboxRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "post",
		path: "/v1/sandbox/fail-next",
		summary: "Make the next count calls to a provider fail (also forced failure on or off)",
		auth: "api_key",
		body: SandboxFailNextRequestSchema,
		success: { status: 200, schema: EmptyOk },
		handler: async (ctx, { body }) => {
			orgOf(ctx);
			const sim = ctx.runtime?.sim;
			if (!sim) {
				throw new ApiError(
					409,
					"unavailable",
					"Sandbox controls require sim providers (FP_SETTLEMENT=mock)",
				);
			}
			sim.controls.failNext(body.providerId, body.count ?? 1);
			if (body.forcedFailure !== undefined) {
				sim.controls.setForcedFailure(body.providerId, body.forcedFailure);
			}
			return {};
		},
	}),
	defineRoute({
		method: "post",
		path: "/v1/sandbox/provider-health",
		summary: "Mark a provider down or up",
		auth: "api_key",
		body: SandboxProviderHealthRequestSchema,
		success: { status: 200, schema: EmptyOk },
		handler: async (ctx, { body }) => {
			orgOf(ctx);
			const sim = ctx.runtime?.sim;
			if (!sim) {
				throw new ApiError(
					409,
					"unavailable",
					"Sandbox controls require sim providers (FP_SETTLEMENT=mock)",
				);
			}
			sim.controls.setHealth(body.providerId, body.health);
			return {};
		},
	}),
	defineRoute({
		method: "post",
		path: "/v1/sandbox/advance-time",
		summary: "Move the API clock (quote and claim expiry)",
		auth: "api_key",
		body: SandboxAdvanceTimeRequestSchema,
		success: { status: 200, schema: SandboxAdvanceTimeResponseSchema },
		handler: async (ctx, { body }) => {
			orgOf(ctx);
			if (!ctx.runtime) throw new ApiError(500, "internal_error", "runtime not configured");
			// CCR-6: API clock only. Ledger time (Stellar / mock vault) is not moved (CCR-5).
			const now = ctx.runtime.clock.advance(body.seconds);
			return { now: now.toISOString() };
		},
	}),
	defineRoute({
		method: "post",
		path: "/v1/sandbox/reset",
		summary: "Reset and reseed the demo",
		auth: "api_key",
		body: SandboxResetRequestSchema,
		success: { status: 200, schema: EmptyOk },
		handler: async (ctx) => {
			const org = orgOf(ctx);
			// Org-scoped wipe (demo reset). No invented global bootstrap schema.
			const payments = await ctx.db.payment.findMany({
				where: { organizationId: org.id },
				select: { id: true },
			});
			const paymentIds = payments.map((p) => p.id);
			if (paymentIds.length > 0) {
				await ctx.db.event.deleteMany({ where: { paymentId: { in: paymentIds } } });
				await ctx.db.auditRow.deleteMany({
					where: { paymentId: { in: paymentIds } },
				});
				await ctx.db.claimLink.deleteMany({
					where: { paymentId: { in: paymentIds } },
				});
				await ctx.db.leg.deleteMany({ where: { paymentId: { in: paymentIds } } });
				await ctx.db.payment.deleteMany({ where: { organizationId: org.id } });
			}
			await ctx.db.event.deleteMany({
				where: { organizationId: org.id, paymentId: null },
			});
			await ctx.db.quote.deleteMany({ where: { organizationId: org.id } });
			await ctx.db.endpoint.deleteMany({ where: { organizationId: org.id } });
			await ctx.db.recipient.deleteMany({ where: { organizationId: org.id } });
			await ctx.db.batch.deleteMany({ where: { organizationId: org.id } });
			await ctx.db.idempotencyRecord.deleteMany({
				where: { organizationId: org.id },
			});
			ctx.runtime?.sim?.controls.reset();
				ctx.runtime?.clock.reset();
			return {};
		},
	}),
];
