import { z } from "zod";
import { IsoTimestamp } from "./common.ts";

// Lane B amends CCR-24 (proposed): reference binding, publicRpcUrl null, intent age.

// CCR-24: Solana USDC intent + confirm (devnet). Auth on confirm: api_key.

/** Base58 Solana signature or address (opaque string; adapter validates). */
const SolanaBase58Schema = z.string().min(32).max(88);

export const SolanaConfigResponseSchema = z
	.object({
		cluster: z.enum(["devnet", "testnet", "mainnet-beta"]),
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
	})
	.strict();

export type SolanaConfigResponse = z.infer<typeof SolanaConfigResponseSchema>;

export const SolanaTransferIntentSchema = z
	.object({
		paymentId: z.string().min(1),
		cluster: z.enum(["devnet", "testnet", "mainnet-beta"]),
		usdcMint: SolanaBase58Schema,
		usdcDecimals: z.number().int().nonnegative(),
		/** Minor units as integer string (USDC decimals). */
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
		paymentStatus: z.literal("paid"),
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
