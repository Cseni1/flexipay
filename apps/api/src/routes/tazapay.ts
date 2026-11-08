import type { Request } from "express";
import { z } from "zod";
import { ApiError } from "../errors.ts";
import { fundAndRun } from "../orchestrator/index.ts";
import type { OrchestratorAdapters } from "../orchestrator/types.ts";
import { defineRoute, type Ctx, type RouteDef } from "../routes.ts";
import { verifyTazapaySignature } from "../tazapay/signature.ts";

type RawRequest = Request & { rawBody?: Buffer };

function adaptersOf(ctx: Ctx): OrchestratorAdapters {
	if (!ctx.runtime) throw new ApiError(500, "internal_error", "runtime not configured");
	return {
		getProvider: ctx.runtime.getProvider,
		settlement: ctx.runtime.settlement,
		vaultPayer: ctx.runtime.vaultPayer,
		now: ctx.runtime.now,
		claimSealKey: ctx.runtime.claimSealKey,
		defaultClaimDestination:
			process.env.FP_RECIPIENT_A_ADDRESS ?? ctx.runtime.vaultPayer,
		partnerProviderIds: new Set(ctx.runtime.liveProviderIds ?? []),
	};
}

const WebhookBodySchema = z.object({}).passthrough();

export const tazapayRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "post",
		path: "/v1/webhooks/tazapay",
		summary: "Tazapay payout webhooks, signature required",
		auth: "none",
		body: WebhookBodySchema,
		success: { status: 200, schema: z.object({ received: z.literal(true) }).strict() },
		handler: async (ctx, { body }) => {
			const secret = process.env.TAZAPAY_WEBHOOK_SECRET?.trim();
			if (!secret) {
				throw new ApiError(
					503,
					"webhook_unconfigured",
					"Tazapay webhooks are not configured",
				);
			}
			const req = (ctx as Ctx & { req?: RawRequest }).req;
			const raw = req?.rawBody;
			const headers = req?.headers ?? {};
			const header = (name: string) => {
				const value = headers[name];
				return Array.isArray(value) ? value[0] : value;
			};
			const record = body as Record<string, unknown>;
			const eventId = typeof record.id === "string" ? record.id : "";
			const createdAt =
				typeof record.created_at === "string" ? record.created_at : "";
			const ok =
				raw &&
				eventId &&
				createdAt &&
				verifyTazapaySignature({
					secret,
					signature: header("signature") ?? "",
					rawBody: raw,
					eventId,
					createdAt,
					nowMs: ctx.runtime?.now().getTime(),
				});
			if (!ok) {
				throw new ApiError(
					400,
					"invalid_signature",
					"Tazapay webhook signature was rejected",
				);
			}
			const event = typeof record.type === "string" ? record.type : "";
			const data =
				record.data && typeof record.data === "object"
					? (record.data as Record<string, unknown>)
					: null;
			const payoutId = typeof data?.id === "string" ? data.id : "";
			if (event.startsWith("payout.") && payoutId && ctx.runtime) {
				// Only the signed payout id selects the leg. The webhook's status is never trusted:
				// fundAndRun re-reads the provider and drives the payment from that result.
				const leg = await ctx.db.leg.findFirst({
					where: { externalRef: payoutId, kind: "payout" },
					select: { paymentId: true },
				});
				if (leg) await fundAndRun(ctx.db, leg.paymentId, adaptersOf(ctx));
			}
			return { received: true as const };
		},
	}),
];
