import {
	ClaimAcceptRequestSchema,
	ClaimAcceptResponseSchema,
	ClaimViewSchema,
	type ClaimView,
} from "@flexipay/domain";
import { ApiError } from "../errors.ts";
import { sha256Hex } from "../ids.ts";
import { completeClaimSettle } from "../orchestrator/index.ts";
import { defineRoute, type RouteDef } from "../routes.ts";

async function loadClaimByToken(db: import("../db.ts").Db, token: string) {
	const tokenHash = sha256Hex(token);
	const link = await db.claimLink.findUnique({
		where: { tokenHash },
		include: {
			payment: {
				include: {
					quote: true,
					legs: { orderBy: { position: "asc" } },
				},
			},
		},
	});
	return link;
}

function toClaimView(
	link: NonNullable<Awaited<ReturnType<typeof loadClaimByToken>>>,
): ClaimView {
	const q = link.payment.quote;
	const dest = q.destination as {
		type: string;
		country: string;
		currency: string;
	};
	const source = q.source as { country: string; currency: string };
	let status = link.status as "open" | "accepted" | "expired";
	if (status === "open" && link.expiresAt.getTime() <= Date.now()) {
		status = "expired";
	}
	const allowed =
		dest.type === "crypto_wallet" || dest.type === "crypto_custodial"
			? (["crypto_wallet"] as const)
			: (["bank_account", "ewallet"] as const);
	return ClaimViewSchema.parse({
		paymentId: link.paymentId,
		status,
		paymentStatus: link.payment.status,
		expiresAt: link.expiresAt.toISOString(),
		amount: {
			amount: q.expectedReceive,
			currency: q.receiveCurrency,
		},
		corridor: {
			from: { country: source.country, currency: source.currency },
			to: { country: dest.country || "", currency: dest.currency },
		},
		allowedDestinationTypes: [...allowed],
		simulated: true,
	});
}

export const claimRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "get",
		path: "/v1/claims/{token}",
		summary: "Public: what is waiting for the recipient",
		auth: "none",
		success: { status: 200, schema: ClaimViewSchema },
		handler: async (ctx, { params }) => {
			const link = await loadClaimByToken(ctx.db, params.token!);
			if (!link) throw new ApiError(404, "not_found", "Claim not found");
			if (link.status === "open" && link.expiresAt.getTime() <= Date.now()) {
				await ctx.db.claimLink.update({
					where: { paymentId: link.paymentId },
					data: { status: "expired" },
				});
				link.status = "expired";
			}
			return toClaimView(link);
		},
	}),
	defineRoute({
		method: "post",
		path: "/v1/claims/{token}/accept",
		summary: "Public: recipient chooses an endpoint and accepts",
		auth: "none",
		body: ClaimAcceptRequestSchema,
		success: { status: 200, schema: ClaimAcceptResponseSchema },
		handler: async (ctx, { params, body }) => {
			if (!ctx.runtime) {
				throw new ApiError(500, "internal_error", "runtime not configured");
			}
			const link = await loadClaimByToken(ctx.db, params.token!);
			if (!link) throw new ApiError(404, "not_found", "Claim not found");
			if (link.status !== "open") {
				throw new ApiError(409, "invalid_state", `claim is ${link.status}`);
			}
			if (link.expiresAt.getTime() <= Date.now()) {
				await ctx.db.claimLink.update({
					where: { paymentId: link.paymentId },
					data: { status: "expired" },
				});
				throw new ApiError(409, "expired", "claim link expired");
			}

			const ep = body.endpoint;
			const crypto =
				ep.type === "crypto_wallet" || ep.type === "crypto_custodial";
			if (!crypto) {
				// Fiat claim accept: payout endpoint selection — needs payout leg pending.
				// MVP crypto path is the contracted DF3 path; fiat claim payout wiring
				// needs endpoint storage contract (report to integrator if required).
				throw new ApiError(
					422,
					"unsupported",
					"Fiat claim accept requires contracted endpoint persistence; use crypto_wallet for MVP claim settle",
				);
			}
			const address =
				typeof ep.details.address === "string"
					? ep.details.address
					: typeof ep.details.wallet === "string"
						? ep.details.wallet
						: null;
			if (!address) {
				throw new ApiError(
					400,
					"validation_error",
					"crypto endpoint details.address (or wallet) required",
				);
			}

			const settle = link.payment.legs.find((l) => l.kind === "settle");
			if (!settle || settle.status !== "processing") {
				// May need fund first — claim accept after fundAndRun left settle processing.
				throw new ApiError(
					409,
					"invalid_state",
					"settle leg is not waiting for claim release (fund payment first)",
				);
			}

			const result = await completeClaimSettle(
				ctx.db,
				link.paymentId,
				{
					getProvider: ctx.runtime.getProvider,
					settlement: ctx.runtime.settlement,
					vaultPayer: ctx.runtime.vaultPayer,
					now: ctx.runtime.now,
					claimSealKey: ctx.runtime.claimSealKey,
				},
				{ destination: address },
			);

			const refreshed = await loadClaimByToken(ctx.db, params.token!);
			if (!refreshed) throw new ApiError(404, "not_found", "Claim not found");
			return {
				claim: toClaimView(refreshed),
				paymentId: link.paymentId,
				paymentStatus: result.status,
			};
		},
	}),
];
