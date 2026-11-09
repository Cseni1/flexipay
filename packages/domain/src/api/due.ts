import { z } from "zod";
import { IsoTimestamp, PaymentStatusSchema } from "./common.ts";

// CCR-51: the sender funds a Due payout from their own Solana wallet. FlexiPay never holds it.

const SolanaAddress = z.string().min(32).max(44);

export const DueFundingRequestSchema = z
	.object({
		/** The Solana wallet that will send the USDC. Due only credits a deposit from this wallet. */
		walletAddress: SolanaAddress,
	})
	.strict();

/** Where the sender is in funding the Due transfer. */
export const DueFundingStateSchema = z.enum([
	/** Due is waiting for the USDC; send it before `expiresAt`. */
	"awaiting_transfer",
	/** The USDC transfer was verified on Solana; Due now converts and pays the bank. */
	"funded",
	/** Due's 2-hour funding window closed before a verified transfer. */
	"expired",
]);

export const DueFundingResponseSchema = z
	.object({
		paymentId: z.string().min(1),
		paymentStatus: PaymentStatusSchema,
		state: DueFundingStateSchema,
		/** Due transfer id. */
		transferId: z.string().min(1),
		cluster: z.string().min(1),
		asset: z.literal("USDC"),
		mint: z.string().min(1),
		decimals: z.number().int().min(0).max(18),
		/** Exact amount to send, in mint minor units. Due does not credit any other amount. */
		amount: z.string().regex(/^\d+$/),
		/** Due's funding address for this transfer (owner of the USDC token account). */
		recipient: SolanaAddress,
		/** Solana Pay reference the transfer must include so FlexiPay can find and verify it. */
		reference: SolanaAddress,
		/** The only wallet Due accepts the deposit from. */
		senderWallet: SolanaAddress,
		expiresAt: IsoTimestamp.nullable(),
		/** Verified transfer signature once funded. */
		signature: z.string().min(1).nullable(),
		explorerTxUrlTemplate: z.string().min(1),
	})
	.strict();

export const DueConfirmRequestSchema = z
	.object({
		signature: z.string().min(32).max(128),
	})
	.strict();

export const DueConfirmResponseSchema = z
	.object({
		paymentId: z.string().min(1),
		paymentStatus: PaymentStatusSchema,
		transferId: z.string().min(1),
		signature: z.string().min(1),
		explorerUrl: z.string().min(1),
	})
	.strict();

export type DueFundingResponse = z.infer<typeof DueFundingResponseSchema>;
export type DueConfirmResponse = z.infer<typeof DueConfirmResponseSchema>;
