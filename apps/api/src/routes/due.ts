import { isSolanaAddress } from "@flexipay/adapter-solana";
import {
	DUE_FUNDING_GRACE_MS,
	DueAdapter,
	decimalToMinor,
} from "@flexipay/adapters-live";
import {
	DueConfirmRequestSchema,
	DueConfirmResponseSchema,
	DueFundingRequestSchema,
	DueFundingResponseSchema,
	ProviderError,
	SENDER_WALLET_DUE_RAIL,
	SolanaConfirmPendingResponseSchema,
	type DueFundingResponse,
	type LegKind,
	type PaymentStatus,
} from "@flexipay/domain";
import { ApiError } from "../errors.ts";
import { fundAndRun } from "../orchestrator/index.ts";
import {
	emitPaymentEvent,
	transitionLeg,
	transitionPayment,
} from "../orchestrator/persist.ts";
import { ensureDirectSolanaIntentBinding } from "../orchestrator/solana-claim.ts";
import { defineRoute, type Ctx, type RouteDef } from "../routes.ts";
import {
	explorerUrlForSignature,
	getSolanaRuntimeConfig,
} from "../solana/runtime-config.ts";
import { verifyPaymentTransfer } from "../solana/verify.ts";
import { adaptersOf, payoutEndpoint } from "./blindpay.ts";

// CCR-51: a Due payout funded from the sender's own Solana wallet. FlexiPay creates the Due
// transfer with the sender's wallet as Due's `sender`, shows Due's funding address and exact
// USDC amount, and verifies the sender's transfer on Solana. The USDC goes from the sender's
// wallet straight to Due; FlexiPay never holds it and no treasury or vault is involved.

const EXPIRED_MESSAGE =
	"Due's 2-hour window to receive the USDC closed before FlexiPay saw your transfer. Due does not credit a late deposit. If you did send it, contact support with the transaction signature.";

const orgOf = (ctx: Ctx) => {
	if (!ctx.org) throw new ApiError(401, "unauthorized", "missing organization");
	return ctx.org;
};

const nowOf = (ctx: Ctx) => (ctx.runtime?.now ?? (() => new Date()))();

/** Ownership first (404), then the shape of the payment (422). */
async function loadDuePayment(ctx: Ctx, paymentId: string) {
	const payment = await ctx.db.payment.findFirst({
		where: { id: paymentId, organizationId: orgOf(ctx).id },
		include: { legs: { orderBy: { position: "asc" } } },
	});
	if (!payment) throw new ApiError(404, "not_found", "Payment not found");
	const settle = payment.legs.find((leg) => leg.kind === "settle");
	const payout = payment.legs.find((leg) => leg.kind === "payout");
	if (settle?.rail !== SENDER_WALLET_DUE_RAIL || !payout) {
		throw new ApiError(
			422,
			"invalid_quote",
			"This payment is not paid from your own wallet through Due",
		);
	}
	return { payment, settle, payout };
}

type DuePayment = Awaited<ReturnType<typeof loadDuePayment>>;

function dueAdapter(ctx: Ctx, providerId: string): DueAdapter {
	const provider = ctx.runtime?.getProvider(providerId);
	if (!(provider instanceof DueAdapter)) {
		throw new ApiError(
			409,
			"partner_unavailable",
			"Due is not available right now. Try again later.",
		);
	}
	return provider;
}

function usdcConfig() {
	const cfg = getSolanaRuntimeConfig();
	return { cfg, mint: cfg.usdcMint, decimals: cfg.usdcDecimals };
}

/** Due's decimal USDC amount -> mint minor units; refused when the mint cannot carry it exactly. */
function exactMinor(amount: string, decimals: number): bigint {
	const m = /^\d+(?:\.(\d*))?$/.exec(amount.trim());
	const minor = decimalToMinor(amount, decimals);
	if (!m || minor === null || minor <= 0n || (m[1] ?? "").replace(/0+$/, "").length > decimals) {
		throw new ApiError(
			502,
			"partner_error",
			"Due returned a funding amount FlexiPay cannot send exactly",
		);
	}
	return minor;
}

/** Unfunded and past Due's deadline (plus grace): settle fails and the payment expires. */
async function expireIfLapsed(ctx: Ctx, d: DuePayment): Promise<boolean> {
	const { payment, settle } = d;
	if (
		payment.status !== "processing" ||
		settle.status !== "processing" ||
		settle.releaseTxRef ||
		!payment.dueFundingExpiresAt ||
		nowOf(ctx).getTime() <=
			payment.dueFundingExpiresAt.getTime() + DUE_FUNDING_GRACE_MS
	) {
		return false;
	}
	await transitionLeg(ctx.db, payment.id, settle.id, "processing", "failed", "due_funding_expired", {
		errorCode: "funding_expired",
		errorMessage: EXPIRED_MESSAGE,
	});
	await emitPaymentEvent(ctx.db, payment.organizationId, payment.id, "leg.failed", {
		legId: settle.id,
		errorCode: "funding_expired",
		errorMessage: EXPIRED_MESSAGE,
		retry: false,
	});
	await transitionPayment(
		ctx.db,
		payment.id,
		payment.organizationId,
		"processing",
		"expired",
		EXPIRED_MESSAGE,
	);
	return true;
}

async function fundingView(ctx: Ctx, paymentId: string): Promise<DueFundingResponse> {
	let d = await loadDuePayment(ctx, paymentId);
	if (await expireIfLapsed(ctx, d)) d = await loadDuePayment(ctx, paymentId);
	const { payment, settle, payout } = d;
	if (
		!payout.externalRef ||
		!payment.dueSenderWallet ||
		!payment.dueFundingAddress ||
		!payment.dueFundingAmount ||
		!payment.solanaPayReference
	) {
		throw new ApiError(
			409,
			"funding_not_prepared",
			"Connect your wallet first so Due can set up the transfer",
		);
	}
	const { cfg, mint, decimals } = usdcConfig();
	const state: DueFundingResponse["state"] = settle.releaseTxRef
		? "funded"
		: payment.status === "expired" || settle.errorCode === "funding_expired"
			? "expired"
			: "awaiting_transfer";
	return {
		paymentId: payment.id,
		paymentStatus: payment.status as PaymentStatus,
		state,
		transferId: payout.externalRef,
		cluster: cfg.cluster,
		asset: "USDC",
		mint,
		decimals,
		amount: payment.dueFundingAmount,
		recipient: payment.dueFundingAddress,
		reference: payment.solanaPayReference,
		senderWallet: payment.dueSenderWallet,
		expiresAt: payment.dueFundingExpiresAt?.toISOString() ?? null,
		signature: settle.releaseTxRef ?? null,
		explorerTxUrlTemplate: cfg.explorerTxUrlTemplate,
	};
}

/**
 * Creates the Due transfer for the sender's wallet (once), then stores Due's funding address,
 * exact amount and deadline. Repeating it with the same wallet returns the same instructions.
 */
async function prepareFunding(
	ctx: Ctx,
	paymentId: string,
	walletAddress: string,
): Promise<DueFundingResponse> {
	const d = await loadDuePayment(ctx, paymentId);
	const { payment, payout } = d;
	if (!isSolanaAddress(walletAddress)) {
		throw new ApiError(422, "invalid_wallet", "That is not a Solana wallet address");
	}
	if (payout.externalRef) {
		if (payment.dueSenderWallet && payment.dueSenderWallet !== walletAddress) {
			throw new ApiError(
				409,
				"wallet_mismatch",
				"Due set this payment up for a different wallet. Pay from that wallet; Due does not credit USDC from any other.",
				{ senderWallet: payment.dueSenderWallet },
			);
		}
		return fundingView(ctx, paymentId);
	}
	if (
		payment.status !== "awaiting_funding" &&
		payment.status !== "funded" &&
		payment.status !== "processing"
	) {
		throw new ApiError(
			409,
			"invalid_status",
			`Cannot pay a payment in status ${payment.status}`,
		);
	}
	const due = dueAdapter(ctx, payout.providerId);
	const endpoint = await payoutEndpoint(ctx, payment);
	const { decimals } = usdcConfig();
	try {
		// The transfer is created first: when Due refuses (for example KYB), the payment stays
		// awaiting funding and the sender can try again.
		const walletId = await due.linkSolanaWallet(walletAddress);
		const created = await due.createSenderWalletTransfer(
			{
				kind: payout.kind as LegKind,
				amountIn: { amount: payout.amountInValue, currency: payout.amountInCurrency },
				outCurrency: payout.amountOutCurrency,
				endpoint,
				paymentId: payment.id,
				legId: payout.id,
				attempt: payout.attempt,
			},
			walletId,
		);
		await ctx.db.leg.update({
			where: { id: payout.id },
			data: { externalRef: created.externalRef },
		});
		if (created.partnerRefs) {
			const current = await ctx.db.endpoint.findUnique({
				where: { id: endpoint.endpointId },
				select: { partnerRefs: true },
			});
			await ctx.db.endpoint.update({
				where: { id: endpoint.endpointId },
				data: {
					partnerRefs: {
						...((current?.partnerRefs as Record<string, string> | null) ?? {}),
						...created.partnerRefs,
					},
				},
			});
		}
		const funding = await due.fundingInstructions(created.externalRef);
		if (funding.currency !== "USDC" || !funding.address || !isSolanaAddress(funding.address)) {
			throw new ApiError(
				502,
				"partner_error",
				"Due did not return a Solana funding address for this transfer",
			);
		}
		const amount = exactMinor(funding.amount, decimals);
		const expiresAt = funding.expiresAt ? new Date(funding.expiresAt) : null;
		await ctx.db.payment.update({
			where: { id: payment.id },
			data: {
				dueSenderWallet: walletAddress,
				dueFundingAddress: funding.address,
				dueFundingAmount: amount.toString(),
				dueFundingExpiresAt:
					expiresAt && Number.isFinite(expiresAt.getTime()) ? expiresAt : null,
			},
		});
		await ensureDirectSolanaIntentBinding(ctx.db, payment.id, nowOf(ctx));
		// Settle moves to processing and waits for the sender's transfer; nothing is locked or held.
		await fundAndRun(ctx.db, payment.id, adaptersOf(ctx));
		await emitPaymentEvent(ctx.db, payment.organizationId, payment.id, "payment.onchain", {
			phase: "due_funding_ready",
			legId: payout.id,
			externalRef: created.externalRef,
			destination: funding.address,
		});
	} catch (e) {
		if (e instanceof ApiError) throw e;
		if (e instanceof ProviderError) throw new ApiError(422, e.code, e.message);
		throw e;
	}
	return fundingView(ctx, paymentId);
}

async function confirmFunding(ctx: Ctx, paymentId: string, signature: string) {
	let d = await loadDuePayment(ctx, paymentId);
	const { cfg, mint, decimals } = usdcConfig();
	const explorerUrl = explorerUrlForSignature(cfg.explorerTxUrlTemplate, signature);
	const done = async () => {
		const after = await ctx.db.payment.findUniqueOrThrow({ where: { id: paymentId } });
		return {
			paymentId,
			paymentStatus: after.status as PaymentStatus,
			transferId: d.payout.externalRef!,
			signature,
			explorerUrl,
		};
	};
	if (d.settle.releaseTxRef) {
		if (d.settle.releaseTxRef !== signature) {
			throw new ApiError(
				409,
				"state_conflict",
				"This payment was already paid with a different Solana transaction",
			);
		}
		return done();
	}
	if (
		!d.payout.externalRef ||
		!d.payment.dueSenderWallet ||
		!d.payment.dueFundingAddress ||
		!d.payment.dueFundingAmount
	) {
		throw new ApiError(
			409,
			"funding_not_prepared",
			"Connect your wallet first so Due can set up the transfer",
		);
	}
	const senderWallet = d.payment.dueSenderWallet;
	const fundingAddress = d.payment.dueFundingAddress;
	const amountMinor = BigInt(d.payment.dueFundingAmount);
	if (await expireIfLapsed(ctx, d)) d = await loadDuePayment(ctx, paymentId);
	if (d.payment.status !== "processing" || d.settle.status !== "processing") {
		throw new ApiError(
			409,
			d.payment.status === "expired" ? "funding_expired" : "invalid_state",
			d.payment.status === "expired"
				? EXPIRED_MESSAGE
				: `Payment is ${d.payment.status}; nothing to confirm`,
		);
	}
	const reused = await ctx.db.leg.findFirst({
		where: { releaseTxRef: signature, NOT: { paymentId } },
		select: { id: true },
	});
	if (reused) {
		throw new ApiError(
			409,
			"signature_reused",
			"This Solana signature was already used on another payment",
		);
	}
	const binding = await ensureDirectSolanaIntentBinding(ctx.db, paymentId, nowOf(ctx));
	const verified = await verifyPaymentTransfer({
		signature,
		mint,
		recipientOwner: fundingAddress,
		amountMinor,
		usdcDecimals: decimals,
		reference: binding.reference,
		notBeforeUnix: Math.floor(binding.intentAt.getTime() / 1000),
	});
	if (!verified.ok && verified.reason === "not_found") {
		return {
			httpStatus: 202 as const,
			body: {
				status: "pending" as const,
				paymentId,
				signature,
				message:
					"Transaction not yet confirmed on Solana; retry confirm without sending again",
			},
		};
	}
	if (!verified.ok && verified.reason === "rpc_error") {
		throw new ApiError(502, "rpc_error", verified.message);
	}
	if (!verified.ok) {
		throw new ApiError(422, "transfer_not_verified", verified.message);
	}
	// Due matches the deposit by sender address and exact amount; anything else is not credited.
	if (verified.payer !== senderWallet) {
		throw new ApiError(
			422,
			"wrong_sender",
			"This transfer came from a different wallet. Due only credits USDC from the wallet you set up, so it will not pay out from this transfer. Contact support about the USDC you sent.",
		);
	}
	if (verified.amountMinor !== amountMinor) {
		throw new ApiError(
			422,
			"amount_mismatch",
			"This transfer is not the exact amount Due asked for. Due does not credit a different amount. Contact support about the USDC you sent.",
		);
	}
	const deadline = d.payment.dueFundingExpiresAt?.getTime();
	if (
		deadline !== undefined &&
		verified.blockTime !== null &&
		verified.blockTime * 1000 > deadline
	) {
		throw new ApiError(422, "funding_expired", EXPIRED_MESSAGE);
	}
	try {
		await ctx.db.leg.update({
			where: { id: d.settle.id },
			data: { releaseTxRef: signature, fundNetwork: "solana" },
		});
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		if (/Leg_releaseTxRef_key|Unique constraint/i.test(message)) {
			throw new ApiError(
				409,
				"signature_reused",
				"This Solana signature was already used on another payment",
			);
		}
		throw cause;
	}
	await emitPaymentEvent(ctx.db, d.payment.organizationId, paymentId, "payment.onchain", {
		phase: "due_sender_wallet_funded",
		releaseTxRef: signature,
		network: "solana",
		destination: fundingAddress,
		payer: verified.payer,
		legId: d.settle.id,
	});
	await transitionLeg(ctx.db, paymentId, d.settle.id, "processing", "succeeded", "due_funding_verified");
	await emitPaymentEvent(ctx.db, d.payment.organizationId, paymentId, "leg.succeeded", {
		legId: d.settle.id,
	});
	// The payout leg now polls Due's transfer status (provider poller) until paid or failed.
	await fundAndRun(ctx.db, paymentId, adaptersOf(ctx));
	return done();
}

export const dueRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "get",
		path: "/v1/payments/{id}/due/funding",
		summary: "Due funding address and exact USDC amount for the sender's wallet",
		auth: "customer",
		success: { status: 200, schema: DueFundingResponseSchema },
		handler: async (ctx, { params }) => fundingView(ctx, params.id!),
	}),
	defineRoute({
		method: "post",
		path: "/v1/payments/{id}/due/funding",
		summary: "Create the Due transfer for the sender's Solana wallet and return where to pay",
		auth: "customer",
		body: DueFundingRequestSchema,
		success: { status: 200, schema: DueFundingResponseSchema },
		handler: async (ctx, { params, body }) =>
			prepareFunding(ctx, params.id!, body.walletAddress),
	}),
	defineRoute({
		method: "post",
		path: "/v1/payments/{id}/due/confirm",
		summary: "Verify the sender's USDC transfer to Due on Solana, then track Due's payout",
		auth: "customer",
		body: DueConfirmRequestSchema,
		success: { status: 200, schema: DueConfirmResponseSchema },
		extraResponses: [
			{
				status: 202,
				description: "Transaction not yet confirmed; retry without sending again",
				schema: SolanaConfirmPendingResponseSchema,
			},
		],
		handler: async (ctx, { params, body }) =>
			confirmFunding(ctx, params.id!, body.signature),
	}),
];
