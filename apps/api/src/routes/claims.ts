import {
	ClaimAcceptRequestSchema,
	ClaimAcceptResponseSchema,
	ClaimViewSchema,
	type ClaimView,
} from "@flexipay/domain";
import { ApiError } from "../errors.ts";
import { newId, sha256Hex } from "../ids.ts";
import {
	acceptFiatClaim,
	ClaimNotWaitingError,
	completeClaimSettle,
	expireClaimIfDue,
	type OrchestratorAdapters,
} from "../orchestrator/index.ts";
import { defineRoute, type RouteDef } from "../routes.ts";
import type { ApiRuntime } from "../runtime.ts";

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

type LoadedClaim = NonNullable<Awaited<ReturnType<typeof loadClaimByToken>>>;

function toClaimView(link: LoadedClaim, now: Date): ClaimView {
	const q = link.payment.quote;
	const dest = q.destination as {
		type: string;
		country: string;
		currency: string;
	};
	const source = q.source as { country: string; currency: string };
	let status = link.status as "open" | "accepted" | "expired";
	if (status === "open" && link.expiresAt.getTime() <= now.getTime()) {
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

function adaptersOf(runtime: ApiRuntime): OrchestratorAdapters {
	return {
		getProvider: runtime.getProvider,
		settlement: runtime.settlement,
		vaultPayer: runtime.vaultPayer,
		now: runtime.now,
		claimSealKey: runtime.claimSealKey,
	};
}

export const claimRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "get",
		path: "/v1/claims/{token}",
		summary: "Public: what is waiting for the recipient",
		auth: "none",
		success: { status: 200, schema: ClaimViewSchema },
		handler: async (ctx, { params }) => {
			let link = await loadClaimByToken(ctx.db, params.token!);
			if (!link) throw new ApiError(404, "not_found", "Claim not found");
			const now = ctx.runtime?.now() ?? new Date();
			// Lazy expiry (ARCHITECTURE §7): an expired open link refunds the lock on first read.
			if (
				ctx.runtime &&
				(await expireClaimIfDue(ctx.db, link.paymentId, adaptersOf(ctx.runtime), now))
			) {
				link = (await loadClaimByToken(ctx.db, params.token!)) ?? link;
			}
			return toClaimView(link, now);
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
			const runtime = ctx.runtime;
			const now = runtime.now();
			const link = await loadClaimByToken(ctx.db, params.token!);
			if (!link) throw new ApiError(404, "not_found", "Claim not found");

			// Idempotent replay: accepted ≠ automatically paid, but both fields are returned.
			if (link.status === "accepted") {
				return {
					claim: toClaimView(link, now),
					paymentId: link.paymentId,
					paymentStatus: link.payment.status,
				};
			}
			if (link.status !== "open") {
				throw new ApiError(409, "invalid_state", `claim is ${link.status}`);
			}
			if (await expireClaimIfDue(ctx.db, link.paymentId, adaptersOf(runtime), now)) {
				throw new ApiError(409, "expired", "claim link expired");
			}

			const ep = body.endpoint;
			const crypto = ep.type === "crypto_wallet" || ep.type === "crypto_custodial";
			const dest = link.payment.quote.destination as {
				type: string;
				country: string;
				currency: string;
			};
			const destIsCrypto =
				dest.type === "crypto_wallet" || dest.type === "crypto_custodial";
			if (crypto !== destIsCrypto) {
				throw new ApiError(
					422,
					"endpoint_mismatch",
					"the chosen endpoint type does not match what this payment was quoted for",
				);
			}

			if (crypto) {
				// Validation (CCR-17) already guarantees details = { address }.
				const address = ep.details.address!;
				const settle = link.payment.legs.find((l) => l.kind === "settle");
				if (!settle || settle.status !== "processing") {
					throw new ApiError(
						409,
						"invalid_state",
						"settle leg is not waiting for claim release (fund payment first)",
					);
				}
				let result: { status: string };
				try {
					result = await completeClaimSettle(ctx.db, link.paymentId, adaptersOf(runtime), {
						destination: address,
					});
				} catch (e) {
					// Release failed: claim stays `open`; payment stays `processing` (accepted ≠ paid).
					const msg = e instanceof Error ? e.message : "release failed";
					throw new ApiError(502, "release_failed", msg);
				}
				const refreshed = await loadClaimByToken(ctx.db, params.token!);
				if (!refreshed) throw new ApiError(404, "not_found", "Claim not found");
				// ClaimLink.status and Payment.status are independent fields in the response.
				return {
					claim: toClaimView(refreshed, now),
					paymentId: link.paymentId,
					paymentStatus: result.status,
				};
			}

			// Fiat (CCR-17): the endpoint must be the type/country/currency the quote priced.
			if (
				ep.type !== dest.type ||
				ep.currency !== dest.currency ||
				ep.country !== dest.country
			) {
				throw new ApiError(
					422,
					"endpoint_mismatch",
					"the chosen endpoint does not match the quoted destination",
				);
			}
			const settleLeg = link.payment.legs.find((l) => l.kind === "settle");
			if (link.payment.status !== "processing" || settleLeg?.status !== "succeeded") {
				throw new ApiError(
					409,
					"invalid_state",
					"payout is not waiting for this claim (fund payment first)",
				);
			}
			const endpointId = newId("end");
			await ctx.db.endpoint.create({
				data: {
					id: endpointId,
					organizationId: link.payment.organizationId,
					recipientId: link.payment.recipientId,
					type: ep.type,
					country: ep.country,
					currency: ep.currency,
					network: ep.network,
					details: ep.details,
					simulated: true,
				},
			});
			let status: string;
			try {
				status = (
					await acceptFiatClaim(ctx.db, link.paymentId, adaptersOf(runtime), {
						endpointId,
					})
				).status;
			} catch (e) {
				if (e instanceof ClaimNotWaitingError) {
					throw new ApiError(
						409,
						"invalid_state",
						"payout is not waiting for this claim (fund payment first)",
					);
				}
				const msg = e instanceof Error ? e.message : "payout failed";
				throw new ApiError(502, "payout_failed", msg);
			}
			const refreshed = await loadClaimByToken(ctx.db, params.token!);
			if (!refreshed) throw new ApiError(404, "not_found", "Claim not found");
			return {
				claim: toClaimView(refreshed, now),
				paymentId: link.paymentId,
				paymentStatus: status,
			};
		},
	}),
];
