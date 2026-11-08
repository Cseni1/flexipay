import { z } from "zod";
import { IsoTimestamp } from "./common.ts";

// Lane B amends CCR-24 (proposed): reference binding, publicRpcUrl null, intent age.

// CCR-24: Solana USDC intent + confirm (devnet). Auth on confirm: api_key.

/** Base58 Solana signature or address (opaque string; adapter validates). */
const SolanaBase58Schema = z.string().min(32).max(88);

/** CCR-26: settlement assets verifiable on Solana. TGBP appears only once its mint is configured. */
export const SolanaAssetSchema = z.enum(["USDC", "TGBP"]);

export const SolanaAssetConfigSchema = z
	.object({
		asset: SolanaAssetSchema,
		mint: SolanaBase58Schema,
		decimals: z.number().int().nonnegative(),
	})
	.strict();

export type SolanaAssetConfigResponse = z.infer<typeof SolanaAssetConfigSchema>;

export const SolanaConfigResponseSchema = z
	.object({
		cluster: z.enum(["devnet", "testnet", "mainnet-beta"]),
		/** CCR-26: every configured settlement asset (USDC always; TGBP when configured). */
		assets: z.array(SolanaAssetConfigSchema).min(1),
		/** Always labelled as test mint on non-mainnet. */
		usdcMint: SolanaBase58Schema,
		usdcDecimals: z.number().int().nonnegative(),
		explorerTxUrlTemplate: z.string().min(1),
		/**
		 * Public read RPC for browser balance fetches only.
		 * Null when unset — never fall back to the server RPC (Lane B / F6).
		 */
		publicRpcUrl: z.string().url().nullable(),
		label: z.string().min(1),
		/**
		 * CCR-49: assets a sender can swap to USDC in their own wallet (Jupiter) before a
		 * sender-wallet payout. Empty off mainnet or when tGBP is not configured.
		 */
		swapInputAssets: z.array(z.literal("TGBP")),
	})
	.strict();

export type SolanaConfigResponse = z.infer<typeof SolanaConfigResponseSchema>;

export const SolanaTransferIntentSchema = z
	.object({
		paymentId: z.string().min(1),
		cluster: z.enum(["devnet", "testnet", "mainnet-beta"]),
		/** CCR-26: the settlement asset of this payment and its mint (equal to usdcMint/usdcDecimals below). */
		asset: SolanaAssetSchema,
		mint: SolanaBase58Schema,
		decimals: z.number().int().nonnegative(),
		/** Deprecated alias of mint/decimals, kept so existing clients keep working (also set for TGBP). */
		usdcMint: SolanaBase58Schema,
		usdcDecimals: z.number().int().nonnegative(),
		/** Minor units as integer string (the asset's mint decimals). */
		amount: z.string().regex(/^\d+$/),
		recipient: SolanaBase58Schema,
		/** Solana Pay reference pubkey the transfer must include (Lane B / F4). */
		reference: SolanaBase58Schema,
		/** ISO time when this intent was first issued (confirm rejects older txs). */
		intentIssuedAt: IsoTimestamp,
		label: z.string().min(1),
		explorerTxUrlTemplate: z.string().min(1),
	})
	.strict();

export type SolanaTransferIntent = z.infer<typeof SolanaTransferIntentSchema>;

export const SolanaConfirmRequestSchema = z
	.object({
		signature: SolanaBase58Schema,
	})
	.strict();

export type SolanaConfirmRequest = z.infer<typeof SolanaConfirmRequestSchema>;

export const SolanaConfirmResponseSchema = z
	.object({
		paymentId: z.string().min(1),
		/**
		 * CCR-39: `paid` when the route ends at settle (claim-link crypto);
		 * `processing` when further convert/payout legs still run after treasury settle.
		 */
		paymentStatus: z.enum(["paid", "processing"]),
		signature: SolanaBase58Schema,
		explorerUrl: z.string().url(),
		verifiedAt: IsoTimestamp,
		cluster: z.enum(["devnet", "testnet", "mainnet-beta"]),
	})
	.strict();

export type SolanaConfirmResponse = z.infer<typeof SolanaConfirmResponseSchema>;

export const SolanaConfirmPendingResponseSchema = z
	.object({
		status: z.literal("pending"),
		paymentId: z.string().min(1),
		signature: SolanaBase58Schema,
		message: z.string().min(1),
	})
	.strict();

export type SolanaConfirmPendingResponse = z.infer<
	typeof SolanaConfirmPendingResponseSchema
>;

// CCR-49: Jupiter swap in the sender's own wallet (mainnet only) before a sender-wallet payout.

export const SolanaSwapRequestSchema = z
	.object({
		/** The sender's Solana wallet that will sign the swap and the payout delegation. */
		walletAddress: SolanaBase58Schema,
		/** Asset the sender pays with; swapped to the payout's USDC. */
		inputAsset: z.literal("TGBP"),
	})
	.strict();

export const SolanaSwapResponseSchema = z.discriminatedUnion("status", [
	z
		.object({
			/** The wallet already holds enough USDC; go straight to the payout approval. */
			status: z.literal("not_needed"),
			/** USDC needed and held, base units of the USDC mint. */
			requiredAmount: z.string().regex(/^\d+$/),
			heldAmount: z.string().regex(/^\d+$/),
			outputDecimals: z.number().int().nonnegative(),
		})
		.strict(),
	z
		.object({
			status: z.literal("ready"),
			provider: z.literal("jupiter"),
			/** Unsigned versioned transaction (base64) for the sender's wallet to sign and send. */
			transaction: z.string().min(1),
			inputAsset: z.literal("TGBP"),
			inputMint: SolanaBase58Schema,
			inputDecimals: z.number().int().nonnegative(),
			/** Expected and maximum (after slippage) input, base units. */
			inputAmount: z.string().regex(/^\d+$/),
			inputMaxAmount: z.string().regex(/^\d+$/),
			outputMint: SolanaBase58Schema,
			outputDecimals: z.number().int().nonnegative(),
			/** USDC the swap delivers (the shortfall), base units. */
			outputAmount: z.string().regex(/^\d+$/),
			requiredAmount: z.string().regex(/^\d+$/),
			heldAmount: z.string().regex(/^\d+$/),
			slippageBps: z.number().int().nonnegative(),
			/** Fraction, e.g. 0.001 = 0.1 %. */
			priceImpact: z.number().nonnegative(),
			route: z.array(z.string()),
		})
		.strict(),
]);

export type SolanaSwapResponse = z.infer<typeof SolanaSwapResponseSchema>;

export const SolanaSwapConfirmRequestSchema = z
	.object({
		walletAddress: SolanaBase58Schema,
		signature: SolanaBase58Schema,
	})
	.strict();

export const SolanaSwapConfirmResponseSchema = z
	.object({
		/** confirmed: the wallet now holds the USDC; pending: ask again shortly. */
		status: z.enum(["confirmed", "pending"]),
		signature: SolanaBase58Schema,
		heldAmount: z.string().regex(/^\d+$/),
		requiredAmount: z.string().regex(/^\d+$/),
	})
	.strict();

export type SolanaSwapConfirmResponse = z.infer<typeof SolanaSwapConfirmResponseSchema>;
