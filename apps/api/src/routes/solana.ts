import {
	SolanaConfigResponseSchema,
	SolanaConfirmPendingResponseSchema,
	SolanaConfirmRequestSchema,
	SolanaConfirmResponseSchema,
	SolanaTransferIntentSchema,
} from "@flexipay/domain";
import {
	flexipayUsdcToSolanaMinor,
	isSolanaAddress,
} from "@flexipay/adapter-solana";
import { ApiError } from "../errors.ts";
import {
	completeSolanaTransferSettle,
	DuplicateSolanaEvidenceError,
	loadSolanaClaimDestination,
} from "../orchestrator/solana-claim.ts";
import { defineRoute, type RouteDef } from "../routes.ts";
import {
	explorerUrlForSignature,
	getSolanaRuntimeConfig,
} from "../solana/runtime-config.ts";
import { verifyPaymentTransfer } from "../solana/verify.ts";

export const solanaRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "get",
		path: "/v1/solana/config",
		summary: "Public Solana cluster/mint labels (devnet test USDC)",
		auth: "none",
		success: { status: 200, schema: SolanaConfigResponseSchema },
		handler: async () => {
			const cfg = getSolanaRuntimeConfig();
			return {
				cluster: cfg.cluster,
				usdcMint: cfg.usdcMint,
				usdcDecimals: cfg.usdcDecimals,
				explorerTxUrlTemplate: cfg.explorerTxUrlTemplate,
				publicRpcUrl: cfg.publicRpcUrl ?? cfg.rpcUrl,
				label: cfg.label,
			};
		},
	}),
	defineRoute({
		method: "get",
		path: "/v1/payments/{id}/solana/intent",
		summary: "Expected Solana USDC transfer for a claim-accepted payment",
		auth: "api_key",
		success: { status: 200, schema: SolanaTransferIntentSchema },
		handler: async (ctx, { params }) => {
			if (!ctx.org) throw new ApiError(401, "unauthorized", "API key required");
			const payment = await ctx.db.payment.findFirst({
				where: { id: params.id!, organizationId: ctx.org.id },
				include: {
					quote: true,
					claimLink: true,
					legs: true,
				},
			});
			if (!payment) throw new ApiError(404, "not_found", "Payment not found");
			if (!payment.claimLink || payment.claimLink.status !== "accepted") {
				throw new ApiError(
					409,
					"invalid_state",
					"Receiver must accept a Solana destination on the claim before the sender pays",
				);
			}
			const destination = await loadSolanaClaimDestination(ctx.db, payment.id);
			if (!destination || !isSolanaAddress(destination)) {
				throw new ApiError(
					409,
					"invalid_state",
					"No Solana destination is bound to this payment",
				);
			}
			const settle = payment.legs.find((l) => l.kind === "settle");
			if (!settle || settle.status !== "processing" || settle.releaseTxRef) {
				throw new ApiError(
					409,
					"invalid_state",
					"Settle leg is not waiting for a verified Solana transfer",
				);
			}
			const cfg = getSolanaRuntimeConfig();
			const amount = flexipayUsdcToSolanaMinor(
				BigInt(payment.quote.expectedReceive),
				cfg.usdcDecimals,
			).toString();
			return {
				paymentId: payment.id,
				cluster: cfg.cluster,
				usdcMint: cfg.usdcMint,
				usdcDecimals: cfg.usdcDecimals,
				amount,
				recipient: destination,
				label: cfg.label,
				explorerTxUrlTemplate: cfg.explorerTxUrlTemplate,
			};
		},
	}),
	defineRoute({
		method: "post",
		path: "/v1/payments/{id}/solana/confirm",
		summary: "Verify on-chain Solana USDC transfer then mark payment paid",
		auth: "api_key",
		body: SolanaConfirmRequestSchema,
		success: { status: 200, schema: SolanaConfirmResponseSchema },
		extraResponses: [
			{
				status: 202,
				description: "Transaction not yet confirmed; retry without a new transfer",
				schema: SolanaConfirmPendingResponseSchema,
			},
		],
		handler: async (ctx, { params, body }) => {
			if (!ctx.org) throw new ApiError(401, "unauthorized", "API key required");
			const payment = await ctx.db.payment.findFirst({
				where: { id: params.id!, organizationId: ctx.org.id },
				include: { quote: true, claimLink: true, legs: true },
			});
			if (!payment) throw new ApiError(404, "not_found", "Payment not found");

			const destination = await loadSolanaClaimDestination(ctx.db, payment.id);
			if (!destination) {
				throw new ApiError(
					409,
					"invalid_state",
					"No Solana destination is bound to this payment",
				);
			}

			const settle = payment.legs.find((l) => l.kind === "settle");
			if (settle?.releaseTxRef) {
				if (settle.releaseTxRef !== body.signature) {
					throw new ApiError(
						409,
						"state_conflict",
						"Payment already verified with a different Solana signature",
					);
				}
				const cfg = getSolanaRuntimeConfig();
				return {
					paymentId: payment.id,
					paymentStatus: "paid" as const,
					signature: settle.releaseTxRef,
					explorerUrl: explorerUrlForSignature(
						cfg.explorerTxUrlTemplate,
						settle.releaseTxRef,
					),
					verifiedAt: new Date().toISOString(),
					cluster: cfg.cluster,
				};
			}

			const cfg = getSolanaRuntimeConfig();
			const amountMinor = flexipayUsdcToSolanaMinor(
				BigInt(payment.quote.expectedReceive),
				cfg.usdcDecimals,
			);
			const verified = await verifyPaymentTransfer({
				signature: body.signature,
				mint: cfg.usdcMint,
				recipientOwner: destination,
				amountMinor,
				usdcDecimals: cfg.usdcDecimals,
			});

			if (!verified.ok && verified.reason === "not_found") {
				return {
					httpStatus: 202 as const,
					body: {
						status: "pending" as const,
						paymentId: payment.id,
						signature: body.signature,
						message:
							"Transaction not yet confirmed on Solana; retry confirm without submitting a new transfer",
					},
				};
			}
			if (!verified.ok && verified.reason === "rpc_error") {
				throw new ApiError(502, "rpc_error", verified.message);
			}
			if (!verified.ok) {
				throw new ApiError(422, "transfer_not_verified", verified.message);
			}

			try {
				const result = await completeSolanaTransferSettle(ctx.db, payment.id, {
					signature: body.signature,
					destination,
				});
				if (result.status !== "paid") {
					throw new ApiError(
						502,
						"internal_error",
						"Solana evidence stored but payment not paid",
					);
				}
			} catch (cause) {
				if (cause instanceof DuplicateSolanaEvidenceError) {
					throw new ApiError(
						409,
						"state_conflict",
						"Payment already verified with a different Solana signature",
					);
				}
				throw cause;
			}

			return {
				paymentId: payment.id,
				paymentStatus: "paid" as const,
				signature: body.signature,
				explorerUrl: explorerUrlForSignature(
					cfg.explorerTxUrlTemplate,
					body.signature,
				),
				verifiedAt: new Date().toISOString(),
				cluster: cfg.cluster,
			};
		},
	}),
];
