import type { Request } from "express";
import { ProviderError } from "@flexipay/domain";
import {
	BlindPayConfirmRequestSchema,
	BlindPayConfirmResponseSchema,
	BlindPayDelegationRequestSchema,
	BlindPayDelegationResponseSchema,
	BlindPayKycBodySchema,
	BlindPayOnboardingRequestSchema,
	BlindPayOnboardingResponseSchema,
	BlindPayTosBodySchema,
	CURRENCY_DECIMALS,
	SENDER_WALLET_BLINDPAY_RAIL,
	type EndpointRef,
} from "@flexipay/domain";
import { z } from "zod";
import { verifyBlindpaySignature } from "../blindpay/signature.ts";
import {
	assertSenderKycApproved,
	blindPayAdapter,
	rememberTos,
	senderWalletOnboarding,
	submitSenderKyc,
} from "../blindpay/onboarding.ts";
import { ApiError } from "../errors.ts";
import { fundAndRun } from "../orchestrator/index.ts";
import { transitionLeg } from "../orchestrator/persist.ts";
import type { OrchestratorAdapters } from "../orchestrator/types.ts";
import { defineRoute, type Ctx, type RouteDef } from "../routes.ts";

const orgOf = (ctx: Ctx) => {
	if (!ctx.org) throw new ApiError(401, "unauthorized", "missing organization");
	return ctx.org;
};

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

function hundredths(value: string, currency: string): number {
	const decimals = CURRENCY_DECIMALS[currency];
	if (decimals === undefined) {
		throw new ApiError(422, "invalid_quote", `BlindPay does not know ${currency}`);
	}
	const minor = BigInt(value);
	if (decimals >= 2) return Number(minor / 10n ** BigInt(decimals - 2));
	return Number(minor * 10n ** BigInt(2 - decimals));
}

async function loadSenderPayment(ctx: Ctx, paymentId: string, orgId: string) {
	const payment = await ctx.db.payment.findFirst({
		where: { id: paymentId, organizationId: orgId },
		include: { legs: { orderBy: { position: "asc" } } },
	});
	if (!payment) throw new ApiError(404, "not_found", "Payment not found");
	const settle = payment.legs.find((leg) => leg.kind === "settle");
	const payout = payment.legs.find((leg) => leg.kind === "payout");
	if (settle?.rail !== SENDER_WALLET_BLINDPAY_RAIL || !payout) {
		throw new ApiError(
			422,
			"invalid_quote",
			"This payment is not a sender-wallet BlindPay payout",
		);
	}
	return { payment, settle, payout };
}

async function payoutEndpoint(ctx: Ctx, payment: {
	organizationId: string;
	endpointId: string | null;
}): Promise<EndpointRef> {
	if (!payment.endpointId) {
		throw new ApiError(
			422,
			"invalid_endpoint",
			"A recipient bank account is required",
		);
	}
	const endpoint = await ctx.db.endpoint.findFirst({
		where: { id: payment.endpointId, organizationId: payment.organizationId },
		include: { recipient: true },
	});
	if (!endpoint) {
		throw new ApiError(404, "not_found", "Endpoint not found");
	}
	const details = (endpoint.details ?? {}) as Record<string, string>;
	if (Object.keys(details).length === 0) {
		throw new ApiError(
			422,
			"invalid_endpoint",
			"The recipient bank details are missing",
		);
	}
	return {
		endpointId: endpoint.id,
		type: endpoint.type as EndpointRef["type"],
		country: endpoint.country ?? "",
		currency: endpoint.currency,
		details,
		recipientName: endpoint.recipient?.name,
		recipientKind: endpoint.recipient?.kind as EndpointRef["recipientKind"],
		partnerRefs: (endpoint.partnerRefs as Record<string, string> | null) ?? undefined,
	};
}

async function prepareDelegation(
	ctx: Ctx,
	orgId: string,
	paymentId: string,
	ownerAddress: string,
) {
	const { payment, payout } = await loadSenderPayment(ctx, paymentId, orgId);
	if (payout.externalRef) {
		throw new ApiError(
			409,
			"payout_started",
			"This payout was already sent to BlindPay",
		);
	}
	const org = await ctx.db.organization.findUniqueOrThrow({
		where: { id: orgId },
		select: { blindpayCustomerId: true, blindpayKycStatus: true },
	});
	if (!org.blindpayCustomerId || org.blindpayKycStatus !== "approved") {
		await assertSenderKycApproved(ctx, orgId);
	}
	const customerId = (
		await ctx.db.organization.findUniqueOrThrow({
			where: { id: orgId },
			select: { blindpayCustomerId: true },
		})
	).blindpayCustomerId;
	if (!customerId) {
		throw new ApiError(422, "kyc_required", "BlindPay customer is missing", {
			step: "submit_kyc",
		});
	}
	if (
		payment.status === "awaiting_funding" ||
		payment.status === "funded" ||
		payment.status === "processing"
	) {
		await fundAndRun(ctx.db, payment.id, adaptersOf(ctx));
	} else {
		throw new ApiError(
			409,
			"invalid_status",
			`Cannot delegate a payment in status ${payment.status}`,
		);
	}
	const fresh = await ctx.db.payment.findUniqueOrThrow({ where: { id: payment.id } });
	const nowMs = (ctx.runtime?.now ?? (() => new Date()))().getTime();
	const sameWallet = fresh.blindpaySenderWallet === ownerAddress;
	const endpoint = await payoutEndpoint(ctx, payment);
	const prepared = await blindPayAdapter(ctx).prepareSenderWalletDelegation({
		customerId,
		endpoint,
		ownerAddress,
		requestAmountHundredths: hundredths(
			payout.amountInValue,
			payout.amountInCurrency,
		),
		existingQuoteId: sameWallet ? fresh.blindpayQuoteId : null,
		quoteExpiresAtMs: sameWallet ? fresh.blindpayQuoteExpiresAt?.getTime() : null,
		nowMs,
	});
	await ctx.db.payment.update({
		where: { id: payment.id },
		data: {
			blindpayQuoteId: prepared.quoteId,
			blindpayQuoteExpiresAt: new Date(prepared.expiresAtMs),
			blindpaySenderWallet: ownerAddress,
		},
	});
	const current = await ctx.db.endpoint.findUnique({
		where: { id: endpoint.endpointId },
		select: { partnerRefs: true },
	});
	await ctx.db.endpoint.update({
		where: { id: endpoint.endpointId },
		data: {
			partnerRefs: {
				...((current?.partnerRefs as Record<string, string> | null) ?? {}),
				...prepared.partnerRefs,
			},
		},
	});
	return {
		transaction: prepared.transaction,
		quoteId: prepared.quoteId,
		expiresAt: new Date(prepared.expiresAtMs).toISOString(),
		ownerAddress,
	};
}

const WebhookBodySchema = z.object({}).passthrough();

export const blindpayRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "post",
		path: "/v1/blindpay/onboarding",
		summary: "Start or resume BlindPay KYC for an individual sender",
		auth: "customer",
		body: BlindPayOnboardingRequestSchema,
		success: { status: 200, schema: BlindPayOnboardingResponseSchema },
		handler: async (ctx, { body }) =>
			senderWalletOnboarding(ctx, orgOf(ctx).id, body.redirectUrl),
	}),
	defineRoute({
		method: "post",
		path: "/v1/blindpay/onboarding/tos",
		summary: "Store the tos id from BlindPay's hosted terms page",
		auth: "customer",
		body: BlindPayTosBodySchema,
		success: { status: 200, schema: BlindPayOnboardingResponseSchema },
		handler: async (ctx, { body }) => rememberTos(ctx, orgOf(ctx).id, body.tosId),
	}),
	defineRoute({
		method: "post",
		path: "/v1/blindpay/onboarding/kyc",
		summary: "Submit the sender's own identity details to BlindPay",
		auth: "customer",
		body: BlindPayKycBodySchema,
		success: { status: 200, schema: BlindPayOnboardingResponseSchema },
		handler: async (ctx, { body }) => submitSenderKyc(ctx, orgOf(ctx).id, body),
	}),
	defineRoute({
		method: "post",
		path: "/v1/payments/{id}/blindpay/delegation",
		summary: "BlindPay delegation transaction for the sender's Solana wallet",
		auth: "customer",
		body: BlindPayDelegationRequestSchema,
		success: { status: 200, schema: BlindPayDelegationResponseSchema },
		handler: async (ctx, { params, body }) => {
			try {
				return await prepareDelegation(
					ctx,
					orgOf(ctx).id,
					params.id!,
					body.ownerAddress,
				);
			} catch (e) {
				if (e instanceof ApiError) throw e;
				if (e instanceof ProviderError) {
					throw new ApiError(422, e.code, e.message);
				}
				throw e;
			}
		},
	}),
	defineRoute({
		method: "post",
		path: "/v1/payments/{id}/blindpay/confirm",
		summary: "Create the BlindPay Solana payout from the delegation signature",
		auth: "customer",
		body: BlindPayConfirmRequestSchema,
		success: { status: 200, schema: BlindPayConfirmResponseSchema },
		handler: async (ctx, { params, body }) => {
			const orgId = orgOf(ctx).id;
			const { payment, settle, payout } = await loadSenderPayment(
				ctx,
				params.id!,
				orgId,
			);
			if (payout.externalRef) {
				if (settle.status === "processing") {
					await transitionLeg(
						ctx.db,
						payment.id,
						settle.id,
						"processing",
						"succeeded",
						"blindpay_accepted",
						{ releaseTxRef: settle.releaseTxRef ?? body.signature },
					);
					await fundAndRun(ctx.db, payment.id, adaptersOf(ctx));
				}
				const current = await ctx.db.payment.findUniqueOrThrow({
					where: { id: payment.id },
				});
				return {
					status: "accepted" as const,
					payoutId: payout.externalRef,
					paymentStatus: current.status,
				};
			}
			if (!payment.blindpayQuoteId || !payment.blindpaySenderWallet) {
				throw new ApiError(
					422,
					"delegation_required",
					"Approve the delegation in your wallet before confirming",
				);
			}
			const nowMs = (ctx.runtime?.now ?? (() => new Date()))().getTime();
			const expires = payment.blindpayQuoteExpiresAt?.getTime() ?? 0;
			if (expires <= nowMs) {
				const again = await prepareDelegation(
					ctx,
					orgId,
					payment.id,
					payment.blindpaySenderWallet,
				);
				return {
					status: "requote" as const,
					transaction: again.transaction,
					quoteId: again.quoteId,
					expiresAt: again.expiresAt,
				};
			}
			if (settle.releaseTxRef && settle.releaseTxRef !== body.signature) {
				throw new ApiError(
					409,
					"signature_mismatch",
					"A different delegation signature is already stored",
				);
			}
			try {
				const created = await blindPayAdapter(ctx).createSenderWalletPayout({
					quoteId: payment.blindpayQuoteId,
					senderWalletAddress: payment.blindpaySenderWallet,
					signature: body.signature,
					idempotencyKey: `flexipay-solana-${payment.id}`,
				});
				await ctx.db.leg.update({
					where: { id: payout.id },
					data: { externalRef: created.id },
				});
				if (settle.status === "processing") {
					await transitionLeg(
						ctx.db,
						payment.id,
						settle.id,
						"processing",
						"succeeded",
						"blindpay_accepted",
						{ releaseTxRef: body.signature },
					);
				}
				await fundAndRun(ctx.db, payment.id, adaptersOf(ctx));
				const after = await ctx.db.payment.findUniqueOrThrow({
					where: { id: payment.id },
				});
				return {
					status: "accepted" as const,
					payoutId: created.id,
					paymentStatus: after.status,
				};
			} catch (e) {
				if (e instanceof ApiError) throw e;
				if (e instanceof ProviderError) throw new ApiError(422, e.code, e.message);
				throw e;
			}
		},
	}),
	defineRoute({
		method: "post",
		path: "/v1/webhooks/blindpay",
		summary: "BlindPay payout and customer webhooks, Svix signature required",
		auth: "none",
		body: WebhookBodySchema,
		success: { status: 200, schema: z.object({ received: z.literal(true) }).strict() },
		handler: async (ctx, { body }) => {
			const secret = process.env.BLINDPAY_WEBHOOK_SECRET?.trim();
			if (!secret) {
				throw new ApiError(
					503,
					"webhook_unconfigured",
					"BlindPay webhooks are not configured",
				);
			}
			const req = (ctx as Ctx & { req?: RawRequest }).req;
			const raw = req?.rawBody;
			const headers = req?.headers ?? {};
			const header = (name: string) => {
				const value = headers[name];
				return Array.isArray(value) ? value[0] : value;
			};
			const ok =
				raw &&
				verifyBlindpaySignature({
					secret,
					svixId: header("svix-id") ?? "",
					svixTimestamp: header("svix-timestamp") ?? "",
					svixSignature: header("svix-signature") ?? "",
					rawBody: raw,
					nowMs: ctx.runtime?.now().getTime(),
				});
			if (!ok) {
				throw new ApiError(400, "invalid_signature", "BlindPay webhook signature was rejected");
			}
			const record = body as Record<string, unknown>;
			const event =
				typeof record.event === "string"
					? record.event
					: typeof record.type === "string"
						? record.type
						: "";
			const data =
				record.data && typeof record.data === "object"
					? (record.data as Record<string, unknown>)
					: record;
			const id = typeof data.id === "string" ? data.id : "";
			if (
				(event === "payout.update" || event === "payout.complete" || event === "payout.new") &&
				id &&
				ctx.runtime
			) {
				const leg = await ctx.db.leg.findFirst({
					where: { externalRef: id, kind: "payout" },
					select: { paymentId: true },
				});
				if (leg) await fundAndRun(ctx.db, leg.paymentId, adaptersOf(ctx));
			}
			if (event === "customer.update" && id) {
				const status =
					typeof data.kyc_status === "string" ? data.kyc_status : undefined;
				if (status) {
					await ctx.db.organization.updateMany({
						where: { blindpayCustomerId: id },
						data: { blindpayKycStatus: status },
					});
				}
			}
			return { received: true as const };
		},
	}),
];
