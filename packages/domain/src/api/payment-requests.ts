import { z } from "zod";
import { IsoTimestamp } from "./common.ts";
import { MoneySchema } from "../money.ts";

// CCR-27: payment requests (the till QR). The merchant asks for an exact amount of pounds;
// the customer pays it in tGBP from any Solana wallet by scanning a Solana Pay QR.

/** Base58 Solana address (opaque string; the API validates it with the adapter). */
const SolanaAddressSchema = z.string().min(32).max(44);

/** Request amount in GBP minor units (pence): 100 (£1.00) to 1,000,000 (£10,000.00). */
export const PaymentRequestAmountSchema = z
	.string()
	.regex(/^[1-9][0-9]*$/, "amount is GBP minor units (pence) as a whole-number string")
	.refine(
		(v) => BigInt(v) >= 100n && BigInt(v) <= 1_000_000n,
		"amount must be between 100 and 1000000 pence",
	);

export const CreatePaymentRequestBodySchema = z
	.object({
		amount: PaymentRequestAmountSchema,
		merchantWallet: SolanaAddressSchema,
		label: z.string().min(1).max(40).optional(),
	})
	.strict();

export type CreatePaymentRequestBody = z.infer<typeof CreatePaymentRequestBodySchema>;

export const PaymentRequestStatusSchema = z.enum(["waiting", "paid", "expired"]);

export const PaymentRequestSchema = z
	.object({
		/** The id of the underlying payment (use it on GET /v1/payments/{id} for the full record). */
		id: z.string().min(1),
		status: PaymentRequestStatusSchema,
		/** What the customer pays on-chain and the merchant receives, in tGBP domain minor units (7 decimals). */
		amount: MoneySchema,
		merchantWallet: SolanaAddressSchema,
		/** Solana Pay reference pubkey the customer's transfer must include. */
		reference: SolanaAddressSchema,
		/** `solana:` transfer-request URL to render as a QR code. */
		solanaPayUrl: z.string().min(1),
		label: z.string().nullable(),
		expiresAt: IsoTimestamp,
		/** Set once paid. */
		signature: z.string().nullable(),
		explorerUrl: z.string().url().nullable(),
		/** Paying wallet from the verified transfer, when known. */
		payer: SolanaAddressSchema.nullable().optional(),
	})
	.strict();

export type PaymentRequest = z.infer<typeof PaymentRequestSchema>;
