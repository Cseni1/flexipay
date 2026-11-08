import {
	assetForSolanaSettleRail,
	floorMinorForSolanaMint,
	SolanaConfigResponseSchema,
	SolanaConfirmPendingResponseSchema,
	SolanaConfirmRequestSchema,
	SolanaConfirmResponseSchema,
	SolanaTransferIntentSchema,
} from "@flexipay/domain";
import type { OrchestratorAdapters } from "../orchestrator/types.ts";
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
import {
	completeSolanaTransferSettle,
	DuplicateSolanaEvidenceError,
	ensureDirectSolanaIntentBinding,
	ensureSolanaIntentIssuedAt,
	isDirectSolanaSettleWaiting,
	loadSolanaClaimDestination,
	ReusedSolanaSignatureError,
} from "../orchestrator/solana-claim.ts";
import { fundAndRun } from "../orchestrator/run.ts";
import { defineRoute, type RouteDef } from "../routes.ts";
import {
	explorerUrlForSignature,
	getSolanaRuntimeConfig,
} from "../solana/runtime-config.ts";
import { swapInputAssets } from "../solana/swap.ts";
import { verifyPaymentTransfer } from "../solana/verify.ts";

/** CCR-26 / CCR-39: configured Solana asset by code, or 422. */
function assetForCode(
	cfg: { assets: SolanaAssetConfig[] },
	code: string,
): SolanaAssetConfig {
	const asset = solanaAssetConfig(cfg, code);
	if (!asset) {
		throw new ApiError(
			422,
			"unsupported_asset",
			`${code} is not a configured Solana settlement asset`,
		);
	}
	return asset;
}

/** Map FlexiPay asset minors → Solana mint minors; unrepresentable amounts are 422. */
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

/** CCR-39: FP_SOLANA_SETTLE_TREASURY owner address for direct settle. */
function solanaSettleTreasury(): string {
	const raw = process.env.FP_SOLANA_SETTLE_TREASURY?.trim() ?? "";
	if (!raw || !isSolanaAddress(raw)) {
		throw new ApiError(
			409,
			"invalid_state",
			"Solana settle treasury not configured",
		);
	}
	return raw;
}

function fundAdaptersOf(ctx: {
	runtime?: {
		getProvider: OrchestratorAdapters["getProvider"];
		settlement: OrchestratorAdapters["settlement"];
		vaultPayer: string;
		now: () => Date;
		claimSealKey: Buffer;
		liveProviderIds?: string[];
	};
}): OrchestratorAdapters {
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

type PaymentLegRow = {
	id: string;
	kind: string;
	rail: string;
	status: string;
	releaseTxRef: string | null;
	position: number;
	amountInValue: string;
	amountInCurrency: string;
};

function assertSettleWaiting(settle: PaymentLegRow | undefined): PaymentLegRow {
	if (!settle || settle.status !== "processing" || settle.releaseTxRef) {
		throw new ApiError(
			409,
			"invalid_state",
			"Settle leg is not waiting for a verified Solana transfer",
		);
	}
	return settle;
}

function assertClaimConfirmReady(payment: {
	status: string;
	claimLink: { status: string } | null;
	legs: PaymentLegRow[];
}): { settle: PaymentLegRow } {
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
	return { settle: assertSettleWaiting(payment.legs.find((l) => l.kind === "settle")) };
}

function assertDirectConfirmReady(payment: {
	status: string;
	delivery: string;
	legs: PaymentLegRow[];
}): { settle: PaymentLegRow } {
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
	if (
		!isDirectSolanaSettleWaiting({
			delivery: payment.delivery,
			legs: payment.legs,
		})
	) {
		throw new ApiError(
			409,
			"invalid_state",
			"Settle leg is not waiting for a verified Solana transfer",
		);
	}
	return { settle: assertSettleWaiting(payment.legs.find((l) => l.kind === "settle")) };
}

function intentAmountFromSettle(
	settle: PaymentLegRow,
	asset: SolanaAssetConfig,
): string {
	const floored = floorMinorForSolanaMint(
		BigInt(settle.amountInValue),
		asset.asset,
		asset.decimals,
	);
	return solanaTransferAmountMinor(floored, asset.decimals).toString();
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
				swapInputAssets: swapInputAssets(),
			};
		},
	}),
	defineRoute({
		method: "get",
		path: "/v1/payments/{id}/solana/intent",
		summary:
			"Expected Solana transfer (claim-accepted destination, or CCR-39 direct treasury)",
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

			const legs = payment.legs as PaymentLegRow[];
			const settle = legs.find((l) => l.kind === "settle");
			const cfg = getSolanaRuntimeConfig();

			const direct = isDirectSolanaSettleWaiting({
				delivery: payment.delivery,
				legs,
			});
			if (direct) {
				assertSettleWaiting(settle);
				const treasury = solanaSettleTreasury();
				const assetCode = assetForSolanaSettleRail(settle!.rail);
				if (!assetCode) {
					throw new ApiError(
						409,
						"invalid_state",
						"Settle leg is not a Solana settlement rail",
					);
				}
				const asset = assetForCode(cfg, assetCode);
				const { reference, intentAt } = await ensureDirectSolanaIntentBinding(
					ctx.db,
					payment.id,
				);
				if (!isSolanaAddress(reference)) {
					throw new ApiError(
						500,
						"internal_error",
						"Stored Solana Pay reference is not a valid address",
					);
				}
				const amount = intentAmountFromSettle(settle!, asset);
				return {
					paymentId: payment.id,
					cluster: cfg.cluster,
					asset: asset.asset,
					mint: asset.mint,
					decimals: asset.decimals,
					usdcMint: asset.mint,
					usdcDecimals: asset.decimals,
					amount,
					recipient: treasury,
					reference,
					intentIssuedAt: intentAt.toISOString(),
					label:
						asset.asset === "USDC"
							? cfg.label
							: cfg.label.replace("USDC", asset.asset),
					explorerTxUrlTemplate: cfg.explorerTxUrlTemplate,
				};
			}

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
			assertSettleWaiting(settle);
			const intentAt = await ensureSolanaIntentIssuedAt(ctx.db, payment.id);
			const asset = assetForCode(cfg, payment.quote.receiveCurrency);
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
				usdcMint: asset.mint,
				usdcDecimals: asset.decimals,
				amount,
				recipient: destination.address,
				reference: destination.reference,
				intentIssuedAt: intentAt.toISOString(),
				label:
					asset.asset === "USDC"
						? cfg.label
						: cfg.label.replace("USDC", asset.asset),
				explorerTxUrlTemplate: cfg.explorerTxUrlTemplate,
			};
		},
	}),
	defineRoute({
		method: "post",
		path: "/v1/payments/{id}/solana/confirm",
		summary:
			"Verify on-chain Solana transfer then mark settle done (CCR-39 may continue partner legs)",
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

			const legs = payment.legs as PaymentLegRow[];
			const settle = legs.find((l) => l.kind === "settle");
			const cfg = getSolanaRuntimeConfig();

			if (settle?.releaseTxRef) {
				if (settle.releaseTxRef !== body.signature) {
					throw new ApiError(
						409,
						"state_conflict",
						"Payment already verified with a different Solana signature",
					);
				}
				return {
					paymentId: payment.id,
					paymentStatus: payment.status as "paid" | "processing",
					signature: settle.releaseTxRef,
					explorerUrl: explorerUrlForSignature(
						cfg.explorerTxUrlTemplate,
						settle.releaseTxRef,
					),
					verifiedAt: new Date().toISOString(),
					cluster: cfg.cluster,
				};
			}

			const direct = isDirectSolanaSettleWaiting({
				delivery: payment.delivery,
				legs,
			});

			if (direct) {
				assertDirectConfirmReady({
					status: payment.status,
					delivery: payment.delivery,
					legs,
				});
				const treasury = solanaSettleTreasury();
				const assetCode = assetForSolanaSettleRail(settle!.rail);
				if (!assetCode) {
					throw new ApiError(
						409,
						"invalid_state",
						"Settle leg is not a Solana settlement rail",
					);
				}
				const asset = assetForCode(cfg, assetCode);
				const binding = await ensureDirectSolanaIntentBinding(ctx.db, payment.id);
				const amountMinor = BigInt(intentAmountFromSettle(settle!, asset));

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

				const verified = await verifyPaymentTransfer({
					signature: body.signature,
					mint: asset.mint,
					recipientOwner: treasury,
					amountMinor,
					usdcDecimals: asset.decimals,
					reference: binding.reference,
					notBeforeUnix: Math.floor(binding.intentAt.getTime() / 1000),
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
					await completeSolanaTransferSettle(ctx.db, payment.id, {
						signature: body.signature,
						destination: treasury,
						payer: verified.payer,
						mint: asset.mint,
						amountMinor: verified.amountMinor,
						decimals: asset.decimals,
					});
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

				const continued = await fundAndRun(
					ctx.db,
					payment.id,
					fundAdaptersOf(ctx),
				);
				const status =
					continued.status === "paid" || continued.status === "processing"
						? continued.status
						: "processing";
				return {
					paymentId: payment.id,
					paymentStatus: status,
					signature: body.signature,
					explorerUrl: explorerUrlForSignature(
						cfg.explorerTxUrlTemplate,
						body.signature,
					),
					verifiedAt: new Date().toISOString(),
					cluster: cfg.cluster,
				};
			}

			// Claim-link path (unchanged behaviour).
			assertClaimConfirmReady({
				status: payment.status,
				claimLink: payment.claimLink,
				legs,
			});

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

			const asset = assetForCode(cfg, payment.quote.receiveCurrency);
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
					mint: asset.mint,
					amountMinor: verified.amountMinor,
					decimals: asset.decimals,
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
