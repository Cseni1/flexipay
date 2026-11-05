import {
	AMOUNT_NOT_REPRESENTABLE_CODE,
	AmountNotRepresentableError,
	flexipayUsdcToSolanaMinor,
	isSolanaAddress,
	solanaAssetConfig,
	type SolanaAssetConfig,
} from "@flexipay/adapter-solana";
import {
	CreatePaymentRequestBodySchema,
	PaymentRequestSchema,
	convertMoney,
	money,
	type PaymentRequest,
} from "@flexipay/domain";
import type { Ctx } from "../routes.ts";
import { defineRoute, type RouteDef } from "../routes.ts";
import { ApiError } from "../errors.ts";
import { newId } from "../ids.ts";
import {
	createPaymentFromQuote,
	fundAndRun,
	FeeDriftError,
} from "../orchestrator/index.ts";
import {
	acceptSolanaClaimDestination,
	completeSolanaTransferSettle,
	DuplicateSolanaEvidenceError,
	ensureSolanaIntentIssuedAt,
	loadSolanaClaimDestination,
	ReusedSolanaSignatureError,
} from "../orchestrator/solana-claim.ts";
import { adaptersOf } from "./claims.ts";
import { createQuoteForOrg } from "./quotes.ts";
import { buildSolanaPayUrl, poundsText } from "../solana/pay-url.ts";
import {
	findReferenceSignatures,
	releaseReferenceLookupSlot,
	takeReferenceLookupSlot,
} from "../solana/reference.ts";
import {
	explorerUrlForSignature,
	getSolanaRuntimeConfig,
} from "../solana/runtime-config.ts";
import { verifyPaymentTransfer } from "../solana/verify.ts";

/** CCR-27: a request stops accepting payment this long after it was created. */
export const PAYMENT_REQUEST_LIFETIME_MS = 15 * 60 * 1000;

/** Marks a payment as a payment request; the rest of the reference is the merchant's label. */
const REFERENCE_PREFIX = "preq:";

const TILL_RECIPIENT_NAME = "Payment requests (till)";

const orgOf = (ctx: Ctx) => {
	if (!ctx.org) throw new ApiError(401, "unauthorized", "missing organization");
	return ctx.org;
};

function tgbpAsset(): SolanaAssetConfig {
	const asset = solanaAssetConfig(getSolanaRuntimeConfig(), "TGBP");
	if (!asset) {
		throw new ApiError(
			422,
			"unsupported_asset",
			"TGBP is not a configured Solana settlement asset",
		);
	}
	return asset;
}

/** tGBP domain minor units (7 decimals) -> mint minor units; unrepresentable is a 422, never a 500. */
function mintMinor(domainMinor: bigint, decimals: number): bigint {
	try {
		return flexipayUsdcToSolanaMinor(domainMinor, decimals);
	} catch (cause) {
		if (cause instanceof AmountNotRepresentableError) {
			throw new ApiError(422, AMOUNT_NOT_REPRESENTABLE_CODE, cause.message);
		}
		throw cause;
	}
}

type LoadedRequest = {
	payment: {
		id: string;
		status: string;
		reference: string | null;
		createdAt: Date;
		quote: { amountValue: string };
		legs: Array<{ kind: string; releaseTxRef: string | null }>;
	};
	destination: { address: string; reference: string; intentAt: Date | null };
};

async function loadRequest(
	ctx: Ctx,
	orgId: string,
	id: string,
): Promise<LoadedRequest> {
	const payment = await ctx.db.payment.findFirst({
		where: { id, organizationId: orgId },
		include: { quote: true, legs: true },
	});
	if (!payment || !payment.reference?.startsWith(REFERENCE_PREFIX)) {
		throw new ApiError(404, "not_found", "Payment request not found");
	}
	const destination = await loadSolanaClaimDestination(ctx.db, payment.id);
	if (!destination) {
		throw new ApiError(404, "not_found", "Payment request not found");
	}
	return { payment, destination };
}

function view(
	loaded: LoadedRequest,
	asset: SolanaAssetConfig,
	status: PaymentRequest["status"],
	signature: string | null,
	explorerTemplate: string,
): PaymentRequest {
	const { payment, destination } = loaded;
	const domainMinor = BigInt(payment.quote.amountValue);
	const label = payment.reference!.slice(REFERENCE_PREFIX.length) || null;
	return {
		id: payment.id,
		status,
		amount: money(domainMinor, "TGBP"),
		merchantWallet: destination.address,
		reference: destination.reference,
		solanaPayUrl: buildSolanaPayUrl({
			merchantWallet: destination.address,
			amountMinor: mintMinor(domainMinor, asset.decimals),
			decimals: asset.decimals,
			mint: asset.mint,
			reference: destination.reference,
			label: label ?? "FlexiPay",
			// 7-decimal domain minor -> pence for the wallet message.
			message: `Pay ${poundsText(domainMinor / 100_000n)}`,
		}),
		label,
		expiresAt: new Date(
			payment.createdAt.getTime() + PAYMENT_REQUEST_LIFETIME_MS,
		).toISOString(),
		signature,
		explorerUrl: signature
			? explorerUrlForSignature(explorerTemplate, signature)
			: null,
	};
}

async function tillRecipientId(ctx: Ctx, orgId: string): Promise<string> {
	const existing = await ctx.db.recipient.findFirst({
		where: { organizationId: orgId, name: TILL_RECIPIENT_NAME },
	});
	if (existing) return existing.id;
	const id = newId("rcp");
	await ctx.db.recipient.create({
		data: {
			id,
			organizationId: orgId,
			name: TILL_RECIPIENT_NAME,
			kind: "company",
			country: "GB",
		},
	});
	return id;
}

export const paymentRequestRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "post",
		path: "/v1/payment-requests",
		summary: "Create a payment request: an exact amount of pounds paid in tGBP by scanning a Solana Pay QR",
		auth: "customer",
		body: CreatePaymentRequestBodySchema,
		success: { status: 201, schema: PaymentRequestSchema },
		handler: async (ctx, { body }) => {
			const org = orgOf(ctx);
			const runtime = ctx.runtime;
			if (!runtime) throw new ApiError(500, "internal_error", "runtime not configured");
			const asset = tgbpAsset();
			if (!isSolanaAddress(body.merchantWallet)) {
				throw new ApiError(
					422,
					"invalid_address",
					"merchantWallet must be a valid Solana wallet address",
				);
			}

			// GBP pence -> tGBP domain minor units at the configured GBP/TGBP rate (1:1 today).
			const rate = ctx.config.fxRates.find((r) => r.from === "GBP" && r.to === "TGBP");
			if (!rate) throw new ApiError(500, "internal_error", "GBP to TGBP rate is not configured");
			const target = convertMoney(money(body.amount, "GBP"), rate.rate, "TGBP");

			// The request amount is what the merchant receives (receive side). PayerPays keeps the
			// vault fee on the payer's side, so the quote's receive amount is the requested pounds.
			const quote = await createQuoteForOrg(ctx, org.id, {
				source: { type: "bank_account", currency: "GBP", country: "GB" },
				destination: {
					type: "crypto_wallet",
					currency: "TGBP",
					country: "",
					recipientKind: "company",
				},
				amount: { side: "receive", value: target },
				policy: "cheapest",
				feeMode: "PayerPays",
			});

			let paymentId: string;
			try {
				const created = await createPaymentFromQuote(ctx.db, {
					organizationId: org.id,
					recipientId: await tillRecipientId(ctx, org.id),
					quoteId: quote.id,
					delivery: "claim_link",
					profile: "one_off",
					reference: `${REFERENCE_PREFIX}${body.label ?? ""}`,
					now: runtime.now(),
				});
				paymentId = created.paymentId;
				await fundAndRun(ctx.db, paymentId, {
					getProvider: runtime.getProvider,
					settlement: runtime.settlement,
					vaultPayer: runtime.vaultPayer,
					now: runtime.now,
					claimSealKey: runtime.claimSealKey,
					defaultClaimDestination:
						process.env.FP_RECIPIENT_A_ADDRESS ?? runtime.vaultPayer,
				});
				await acceptSolanaClaimDestination(ctx.db, paymentId, {
					address: body.merchantWallet,
					currency: "TGBP",
					adapters: adaptersOf(runtime),
				});
				await ensureSolanaIntentIssuedAt(ctx.db, paymentId, runtime.now());
			} catch (e) {
				if (e instanceof FeeDriftError) {
					throw new ApiError(409, "fee_drift", e.message);
				}
				if (e instanceof ApiError) throw e;
				throw new ApiError(
					409,
					"invalid_state",
					e instanceof Error ? e.message : "payment request could not be created",
				);
			}

			const loaded = await loadRequest(ctx, org.id, paymentId);
			return view(
				loaded,
				asset,
				"waiting",
				null,
				getSolanaRuntimeConfig().explorerTxUrlTemplate,
			);
		},
	}),
	defineRoute({
		method: "get",
		path: "/v1/payment-requests/{id}",
		summary: "Payment request status; finds the customer's transfer on-chain by its Solana Pay reference",
		auth: "customer",
		success: { status: 200, schema: PaymentRequestSchema },
		handler: async (ctx, { params }) => {
			const org = orgOf(ctx);
			const runtime = ctx.runtime;
			if (!runtime) throw new ApiError(500, "internal_error", "runtime not configured");
			const asset = tgbpAsset();
			const cfg = getSolanaRuntimeConfig();
			const loaded = await loadRequest(ctx, org.id, params.id!);
			const { payment, destination } = loaded;

			const settle = payment.legs.find((l) => l.kind === "settle");
			if (payment.status === "paid" && settle?.releaseTxRef) {
				releaseReferenceLookupSlot(payment.id);
				return view(loaded, asset, "paid", settle.releaseTxRef, cfg.explorerTxUrlTemplate);
			}

			const now = runtime.now();
			const expiresAt = payment.createdAt.getTime() + PAYMENT_REQUEST_LIFETIME_MS;
			if (now.getTime() >= expiresAt || payment.status !== "processing") {
				releaseReferenceLookupSlot(payment.id);
				return view(loaded, asset, "expired", null, cfg.explorerTxUrlTemplate);
			}
			if (!takeReferenceLookupSlot(payment.id)) {
				return view(loaded, asset, "waiting", null, cfg.explorerTxUrlTemplate);
			}

			let signatures: string[];
			try {
				signatures = await findReferenceSignatures(destination.reference, 5);
			} catch (cause) {
				throw new ApiError(
					502,
					"rpc_error",
					cause instanceof Error ? cause.message : "Solana look-up failed",
				);
			}

			const amountMinor = mintMinor(BigInt(payment.quote.amountValue), asset.decimals);
			const intentAt =
				destination.intentAt ?? (await ensureSolanaIntentIssuedAt(ctx.db, payment.id, now));
			for (const signature of signatures) {
				const verified = await verifyPaymentTransfer({
					signature,
					mint: asset.mint,
					recipientOwner: destination.address,
					amountMinor,
					usdcDecimals: asset.decimals,
					reference: destination.reference,
					notBeforeUnix: Math.floor(intentAt.getTime() / 1000),
				});
				if (!verified.ok && verified.reason === "rpc_error") {
					throw new ApiError(502, "rpc_error", verified.message);
				}
				if (!verified.ok) continue;
				try {
					const result = await completeSolanaTransferSettle(ctx.db, payment.id, {
						signature,
						destination: destination.address,
						payer: verified.payer,
					});
					if (result.status !== "paid") continue;
				} catch (cause) {
					if (
						cause instanceof ReusedSolanaSignatureError ||
						cause instanceof DuplicateSolanaEvidenceError
					) {
						continue;
					}
					throw cause;
				}
				releaseReferenceLookupSlot(payment.id);
				return view(loaded, asset, "paid", signature, cfg.explorerTxUrlTemplate);
			}
			return view(loaded, asset, "waiting", null, cfg.explorerTxUrlTemplate);
		},
	}),
];
