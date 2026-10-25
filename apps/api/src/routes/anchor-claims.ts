import {
	AnchorIndicativePriceRequestSchema,
	AnchorIndicativePriceResponseSchema,
	AnchorWithdrawRequestSchema,
	AnchorWithdrawResponseSchema,
	AnchorWithdrawStatusResponseSchema,
	type AnchorIndicativePriceResponse,
	type AnchorWithdrawResponse,
	type AnchorWithdrawStatusResponse,
} from "@flexipay/domain";
import type { Request } from "express";
import {
	createEnvAnchorClaimGateway,
	resolveClassicAuthSecret,
	type AnchorClaimGateway,
} from "../anchor/claim-anchor-gateway.ts";
import { ApiError } from "../errors.ts";
import { withIdempotency } from "../idempotency.ts";
import { emitPaymentEvent } from "../orchestrator/persist.ts";
import { expireClaimIfDue } from "../orchestrator/index.ts";
import { defineRoute, type Ctx, type RouteDef } from "../routes.ts";
import type { ApiRuntime } from "../runtime.ts";
import { loadClaimByToken, type LoadedClaim } from "./claims.ts";

/** Set by app.ts when route.idempotency === "claim". */
export type CtxWithRequest = Ctx & { req?: Request };

const CLASSIC_G = /^G[A-Z0-9]{55}$/;

function gatewayOf(runtime: ApiRuntime): AnchorClaimGateway {
	if (runtime.anchorGateway) return runtime.anchorGateway;
	return createEnvAnchorClaimGateway(process.env);
}

function adaptersOf(runtime: ApiRuntime) {
	return {
		getProvider: runtime.getProvider,
		settlement: runtime.settlement,
		vaultPayer: runtime.vaultPayer,
		now: runtime.now,
		claimSealKey: runtime.claimSealKey,
	};
}

function settleLeg(link: LoadedClaim) {
	return link.payment.legs.find((l: { kind: string }) => l.kind === "settle");
}

/**
 * Lazy expiry + status guards shared by anchor claim routes (CCR-22).
 * Claim must not be expired; settle must not be failed.
 */
async function prepareClaimForAnchor(
	ctx: Ctx,
	token: string,
): Promise<LoadedClaim> {
	if (!ctx.runtime) {
		throw new ApiError(500, "internal_error", "runtime not configured");
	}
	let link = await loadClaimByToken(ctx.db, token);
	if (!link) throw new ApiError(404, "not_found", "Claim not found");
	const now = ctx.runtime.now();
	if (
		await expireClaimIfDue(ctx.db, link.paymentId, adaptersOf(ctx.runtime), now)
	) {
		link = (await loadClaimByToken(ctx.db, token)) ?? link;
	}
	if (link.status === "expired" || link.expiresAt.getTime() <= now.getTime()) {
		throw new ApiError(409, "expired", "claim link expired");
	}
	const settle = settleLeg(link);
	if (settle && (settle.status === "failed" || settle.errorCode === "fee_drift")) {
		throw new ApiError(
			409,
			"settle_failed",
			"the funds for this payment were returned; anchor withdraw is refused",
		);
	}
	if (
		link.payment.status === "failed" ||
		link.payment.status === "refunded" ||
		link.payment.status === "expired"
	) {
		throw new ApiError(
			409,
			"invalid_state",
			`payment is ${link.payment.status}; anchor withdraw is refused`,
		);
	}
	return link;
}

/**
 * Vault release → classic G… required before SEP-24 withdraw (CCR-22).
 * Passkey C… destinations are out of scope for this M1 classic path.
 */
function assertReleasedToClassic(link: LoadedClaim): {
	classicAddress: string;
	releaseTxRef: string;
} {
	const settle = settleLeg(link);
	if (!settle?.releaseTxRef) {
		throw new ApiError(
			409,
			"invalid_state",
			"vault release to classic G… is required before anchor withdraw (missing Leg.releaseTxRef)",
		);
	}
	const classic =
		link.recipientClassicAddress?.trim() ||
		undefined;
	if (!classic || !CLASSIC_G.test(classic)) {
		throw new ApiError(
			409,
			"invalid_state",
			"vault release classic G… address is not bound on this claim (accept crypto_wallet G… first)",
		);
	}
	if (link.status !== "open" && link.status !== "accepted") {
		throw new ApiError(409, "invalid_state", `claim is ${link.status}`);
	}
	return { classicAddress: classic, releaseTxRef: settle.releaseTxRef };
}

function authSecretFor(
	runtime: ApiRuntime,
	classicAddress: string,
): string {
	const fromRuntime = runtime.resolveAnchorAuthSecret?.(classicAddress);
	if (fromRuntime) return fromRuntime;
	const fromEnv = resolveClassicAuthSecret(classicAddress, process.env);
	if (fromEnv) return fromEnv;
	throw new ApiError(
		502,
		"anchor_unavailable",
		"no custodial SEP-10 secret configured for the vault-release classic address",
	);
}

export const anchorClaimRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "post",
		path: "/v1/claims/{token}/anchor/indicative-price",
		summary:
			"Public: SEP-38 indicative withdraw price (context=sep6; not a binding quote)",
		auth: "none",
		body: AnchorIndicativePriceRequestSchema,
		success: { status: 200, schema: AnchorIndicativePriceResponseSchema },
		handler: async (ctx, { body, params }) => {
			const link = await prepareClaimForAnchor(ctx, params.token!);
			if (link.status !== "open" && link.status !== "accepted") {
				throw new ApiError(409, "invalid_state", `claim is ${link.status}`);
			}
			const gw = gatewayOf(ctx.runtime!);
			const result = await gw.indicativePrice(body.sellAmount);
			const out: AnchorIndicativePriceResponse =
				AnchorIndicativePriceResponseSchema.parse(result);
			return out;
		},
	}),

	defineRoute({
		method: "post",
		path: "/v1/claims/{token}/anchor/withdraw",
		summary:
			"Public: start reference-anchor SEP-24 withdraw; returns sanitised hosted URL",
		auth: "none",
		idempotency: "claim",
		body: AnchorWithdrawRequestSchema,
		success: { status: 200, schema: AnchorWithdrawResponseSchema },
		handler: async (ctx, { body, params }) => {
			const req = (ctx as CtxWithRequest).req;
			if (!req) {
				throw new ApiError(500, "internal_error", "request context missing");
			}
			const token = params.token!;
			// Claim load + expiry before idempotency so missing key still returns 400
			// after a valid claim token (same order as CCR-21 passkey deploy).
			const link0 = await prepareClaimForAnchor(ctx, token);
			const orgId = link0.payment.organizationId;

			const result = await withIdempotency(
				ctx.db,
				req,
				orgId,
				async () => {
					const link = await prepareClaimForAnchor(ctx, token);
					const released = assertReleasedToClassic(link);

					// Idempotent / recovery: existing binding — never blind re-start.
					if (link.anchorTxId) {
						if (
							link.anchorWithdrawAmount &&
							link.anchorWithdrawAmount !== body.amount
						) {
							throw new ApiError(
								409,
								"invalid_state",
								"anchor withdraw already started for a different amount on this claim",
							);
						}
						const cached: AnchorWithdrawResponse = {
							anchorTxId: link.anchorTxId,
							urlSanitised: link.anchorUrlSanitised ?? "",
							kind: "withdrawal",
						};
						if (!cached.urlSanitised) {
							throw new ApiError(
								409,
								"invalid_state",
								"anchor withdraw already started; poll status instead of re-starting",
							);
						}
						return {
							status: 200,
							body: AnchorWithdrawResponseSchema.parse(cached),
						};
					}

					const secret = authSecretFor(ctx.runtime!, released.classicAddress);
					const gw = gatewayOf(ctx.runtime!);
					const started = await gw.startWithdraw({
						amount: body.amount,
						type: body.type,
						classicAccount: released.classicAddress,
						authSecret: secret,
					});

					await ctx.db.claimLink.update({
						where: { paymentId: link.paymentId },
						data: {
							anchorTxId: started.anchorTxId,
							anchorUrlSanitised: started.urlSanitised,
							anchorWithdrawAmount: body.amount,
						},
					});

					await emitPaymentEvent(
						ctx.db,
						link.payment.organizationId,
						link.paymentId,
						"payment.onchain",
						{
							phase: "anchor_withdraw_started",
							anchorTxId: started.anchorTxId,
							urlSanitised: started.urlSanitised,
							releaseTxRef: released.releaseTxRef,
							kind: "withdrawal",
							network: "testnet",
							label: "reference anchor on testnet",
						},
					);

					return {
						status: 200,
						body: AnchorWithdrawResponseSchema.parse({
							anchorTxId: started.anchorTxId,
							urlSanitised: started.urlSanitised,
							kind: "withdrawal",
						}),
					};
				},
				{
					required: true,
					beforeReturnCache: async () => {
						const again = await loadClaimByToken(ctx.db, token);
						if (!again) throw new ApiError(404, "not_found", "Claim not found");
						if (again.payment.organizationId !== orgId) {
							throw new ApiError(
								409,
								"idempotency_conflict",
								"claim organization no longer matches Idempotency-Key scope",
							);
						}
					},
				},
			);
			return result.body;
		},
	}),

	defineRoute({
		method: "get",
		path: "/v1/claims/{token}/anchor/withdraw/{anchorTxId}",
		summary: "Public: SEP-24 withdraw status for this claim's anchorTxId",
		auth: "none",
		success: { status: 200, schema: AnchorWithdrawStatusResponseSchema },
		handler: async (ctx, { params }) => {
			const link = await prepareClaimForAnchor(ctx, params.token!);
			const anchorTxId = params.anchorTxId!;
			// Cross-claim / unbound id → 404 (do not leak other claims' txs).
			if (!link.anchorTxId || link.anchorTxId !== anchorTxId) {
				throw new ApiError(404, "not_found", "Anchor transaction not found for this claim");
			}
			const { classicAddress, releaseTxRef } = assertReleasedToClassic(link);
			const secret = authSecretFor(ctx.runtime!, classicAddress);
			const gw = gatewayOf(ctx.runtime!);
			const view = await gw.getWithdrawStatus({
				anchorTxId,
				classicAccount: classicAddress,
				authSecret: secret,
			});

			if (
				view.stellarTransactionId &&
				view.stellarTransactionId !== link.anchorPaymentTxHash
			) {
				await ctx.db.claimLink.update({
					where: { paymentId: link.paymentId },
					data: { anchorPaymentTxHash: view.stellarTransactionId },
				});
				await emitPaymentEvent(
					ctx.db,
					link.payment.organizationId,
					link.paymentId,
					"payment.onchain",
					{
						phase: "anchor_payment_observed",
						anchorTxId,
						anchorPaymentTxHash: view.stellarTransactionId,
						releaseTxRef,
						sep24Status: view.status,
						network: "testnet",
					},
				);
			}

			const out: AnchorWithdrawStatusResponse =
				AnchorWithdrawStatusResponseSchema.parse({
					anchorTxId: view.anchorTxId,
					status: view.status,
					...(view.amountIn ? { amountIn: view.amountIn } : {}),
					...(view.withdrawAnchorAccount
						? { withdrawAnchorAccount: view.withdrawAnchorAccount }
						: {}),
					withdrawMemoPresent: view.withdrawMemoPresent,
					...(view.stellarTransactionId
						? { stellarTransactionId: view.stellarTransactionId }
						: {}),
				});
			return out;
		},
	}),
];
