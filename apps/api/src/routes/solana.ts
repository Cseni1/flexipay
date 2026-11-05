import {
	SolanaConfigResponseSchema,
	SolanaConfirmPendingResponseSchema,
	SolanaConfirmRequestSchema,
	SolanaConfirmResponseSchema,
	SolanaTransferIntentSchema,
} from "@flexipay/domain";
import {
	solanaAssetConfig,
	type SolanaAssetConfig,
} from "@flexipay/adapter-solana";
import {
	AmountNotRepresentableError,
	AMOUNT_NOT_REPRESENTABLE_CODE,
	flexipayUsdcToSolanaMinor,
	isSolanaAddress,
} from "@flexipay/adapter-solana";
import { ApiError } from "../errors.ts";

/** CCR-26: the configured Solana asset for a quote's receive currency, or a 422. */
function assetForQuote(
	cfg: { assets: SolanaAssetConfig[] },
	receiveCurrency: string,
): SolanaAssetConfig {
	const asset = solanaAssetConfig(cfg, receiveCurrency);
	if (!asset) {
		throw new ApiError(
			422,
			"unsupported_asset",
			`${receiveCurrency} is not a configured Solana settlement asset`,
		);
	}
	return asset;
}

/** Map FlexiPay asset (USDC/TGBP, same 7-decimal convention) → Solana mint minor units; unrepresentable amounts are 422, never 500. */
function solanaTransferAmountMinor(
	flexipayMinor: bigint,
	usdcDecimals: number,
): bigint {
	try {
		return flexipayUsdcToSolanaMinor(flexipayMinor, usdcDecimals);
	} catch (cause) {
		if (
			cause instanceof AmountNotRepresentableError ||
			(cause instanceof Error &&
				/not representable at the Solana .* mint/i.test(cause.message))
		) {
			throw new ApiError(
				422,
				AMOUNT_NOT_REPRESENTABLE_CODE,
				cause instanceof Error
					? cause.message
					: "payment amount is not representable at the Solana mint decimals",
			);
		}
		throw cause;
	}
}
import {
	completeSolanaTransferSettle,
	DuplicateSolanaEvidenceError,
	ensureSolanaIntentIssuedAt,
	loadSolanaClaimDestination,
	ReusedSolanaSignatureError,
} from "../orchestrator/solana-claim.ts";
import { defineRoute, type RouteDef } from "../routes.ts";
import {
	explorerUrlForSignature,
	getSolanaRuntimeConfig,
} from "../solana/runtime-config.ts";
import { verifyPaymentTransfer } from "../solana/verify.ts";

function assertSolanaConfirmReady(payment: {
	status: string;
	claimLink: { status: string } | null;
	legs: Array<{
		kind: string;
		status: string;
		releaseTxRef: string | null;
	}>;
}): {
	settle: { kind: string; status: string; releaseTxRef: string | null };
} {
	if (!payment.claimLink || payment.claimLink.status !== "accepted") {
		throw new ApiError(
			409,
			"invalid_state",
			"Receiver must accept a Solana destination on the claim before the sender pays",
		);
	}
	if (payment.status === "refunded" || payment.status === "expired") {
		throw new ApiError(
			409,
			"invalid_state",
			`Payment is ${payment.status}; Solana confirm is refused`,
		);
	}
	if (payment.status !== "processing") {
		throw new ApiError(
			409,
			"invalid_state",
			`Payment must be processing to confirm Solana transfer (got ${payment.status})`,
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
	return { settle };
}

export const solanaRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "get",
		path: "/v1/solana/config",
		summary: "Public Solana cluster, settlement assets and mint labels (devnet test USDC / tGBP)",
		auth: "none",
		success: { status: 200, schema: SolanaConfigResponseSchema },
		handler: async () => {
			const cfg = getSolanaRuntimeConfig();
			return {
				cluster: cfg.cluster,
				assets: cfg.assets,
				usdcMint: cfg.usdcMint,
				usdcDecimals: cfg.usdcDecimals,
				explorerTxUrlTemplate: cfg.explorerTxUrlTemplate,
				// F6: never fall back to the server RPC URL (may embed API keys).
				publicRpcUrl: cfg.publicRpcUrl ?? null,
				label: cfg.label,
			};
		},
	}),
	defineRoute({
		method: "get",
		path: "/v1/payments/{id}/solana/intent",
		summary: "Expected Solana transfer (USDC or tGBP) for a claim-accepted payment",
		auth: "customer",
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
			if (
				!destination ||
				!isSolanaAddress(destination.address) ||
				!isSolanaAddress(destination.reference)
			) {
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
			const intentAt = await ensureSolanaIntentIssuedAt(ctx.db, payment.id);
			const cfg = getSolanaRuntimeConfig();
			const asset = assetForQuote(cfg, payment.quote.receiveCurrency);
			const amount = solanaTransferAmountMinor(
				BigInt(payment.quote.expectedReceive),
				asset.decimals,
			).toString();
			return {
				paymentId: payment.id,
				cluster: cfg.cluster,
				asset: asset.asset,
				mint: asset.mint,
				decimals: asset.decimals,
				// Deprecated aliases (CCR-26): equal mint/decimals, also for TGBP.
				usdcMint: asset.mint,
				usdcDecimals: asset.decimals,
				amount,
				recipient: destination.address,
				reference: destination.reference,
				intentIssuedAt: intentAt.toISOString(),
				label: asset.asset === "USDC" ? cfg.label : cfg.label.replace("USDC", asset.asset),
				explorerTxUrlTemplate: cfg.explorerTxUrlTemplate,
			};
		},
	}),
	defineRoute({
		method: "post",
		path: "/v1/payments/{id}/solana/confirm",
		summary: "Verify on-chain Solana transfer (USDC or tGBP) then mark payment paid",
		auth: "customer",
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

			// F8: same readiness checks as intent — before any RPC verify.
			assertSolanaConfirmReady(payment);

			const destination = await loadSolanaClaimDestination(ctx.db, payment.id);
			if (!destination) {
				throw new ApiError(
					409,
					"invalid_state",
					"No Solana destination is bound to this payment",
				);
			}

			const reused = await ctx.db.leg.findFirst({
				where: {
					releaseTxRef: body.signature,
					NOT: { paymentId: payment.id },
				},
				select: { paymentId: true },
			});
			if (reused) {
				throw new ApiError(
					409,
					"signature_reused",
					"This Solana signature was already used on another payment",
				);
			}

			const cfg = getSolanaRuntimeConfig();
			const asset = assetForQuote(cfg, payment.quote.receiveCurrency);
			const amountMinor = solanaTransferAmountMinor(
				BigInt(payment.quote.expectedReceive),
				asset.decimals,
			);
			const intentAt =
				destination.intentAt ??
				(await ensureSolanaIntentIssuedAt(ctx.db, payment.id));
			const verified = await verifyPaymentTransfer({
				signature: body.signature,
				mint: asset.mint,
				recipientOwner: destination.address,
				amountMinor,
				usdcDecimals: asset.decimals,
				reference: destination.reference,
				notBeforeUnix: Math.floor(intentAt.getTime() / 1000),
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
					destination: destination.address,
					payer: verified.payer,
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
				if (cause instanceof ReusedSolanaSignatureError) {
					throw new ApiError(
						409,
						"signature_reused",
						"This Solana signature was already used on another payment",
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
