import {
	ClaimAcceptRequestSchema,
	ClaimAcceptResponseSchema,
	ClaimViewSchema,
	type ClaimView,
} from "@flexipay/domain";
import { ApiError } from "../errors.ts";
import { sha256Hex } from "../ids.ts";
import { ClaimReleaseRefusedError, completeClaimSettle } from "../orchestrator/index.ts";
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

			// Idempotent replay: accepted ≠ automatically paid, but both fields are returned.
			if (link.status === "accepted") {
				return {
					claim: toClaimView(link),
					paymentId: link.paymentId,
					paymentStatus: link.payment.status,
				};
			}
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
				throw new ApiError(
					422,
					"unsupported",
					"Fiat claim accept blocked until POST /v1/endpoints + ClaimAcceptEndpoint.details keys are contracted",
				);
			}
			// Do not invent keys from the web UI. Only `address` is used for crypto release
			// until the integrator contracts details (address | accountNumber | phoneNumber | …).
			if (
				ep.details.accountNumber !== undefined ||
				ep.details.phoneNumber !== undefined
			) {
				throw new ApiError(
					422,
					"uncontracted_details",
					"details.accountNumber/phoneNumber are not an accepted claim-accept contract yet",
				);
			}
			const address =
				typeof ep.details.address === "string" ? ep.details.address : null;
			if (!address) {
				throw new ApiError(
					400,
					"validation_error",
					"crypto endpoint details.address required (string)",
				);
			}

			const settle = link.payment.legs.find((l) => l.kind === "settle");
			// CCR-15 step 3: a failed / drift-failed settle leg is never released or marked paid.
			if (settle && (settle.status === "failed" || settle.errorCode === "fee_drift")) {
				throw new ApiError(
					409,
					"settle_failed",
					"the funds for this payment were returned; the claim cannot be accepted",
				);
			}
			if (!settle || settle.status !== "processing") {
				throw new ApiError(
					409,
					"invalid_state",
					"settle leg is not waiting for claim release (fund payment first)",
				);
			}

			let result: { status: string };
			try {
				result = await completeClaimSettle(
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
			} catch (e) {
				if (e instanceof ClaimReleaseRefusedError) {
					throw new ApiError(409, "settle_failed", e.message);
				}
				// Release failed: claim stays `open`; payment stays `processing` (accepted ≠ paid).
				const msg = e instanceof Error ? e.message : "release failed";
				throw new ApiError(502, "release_failed", msg);
			}

			const refreshed = await loadClaimByToken(ctx.db, params.token!);
			if (!refreshed) throw new ApiError(404, "not_found", "Claim not found");
			// ClaimLink.status and Payment.status are independent fields in the response.
			return {
				claim: toClaimView(refreshed),
				paymentId: link.paymentId,
				paymentStatus: result.status,
			};
		},
	}),
];
