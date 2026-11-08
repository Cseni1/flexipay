import { z } from "zod";
import { IsoTimestamp, PaymentStatusSchema } from "./common.ts";

// CCR-45: an individual pays BlindPay from their own Solana wallet.

export const BlindPayKycBodySchema = z
	.object({
		email: z.string().email(),
		first_name: z.string().min(1).max(80),
		last_name: z.string().min(1).max(80),
		date_of_birth: z.string().min(8).max(40),
		tax_id: z.string().min(1).max(40),
		address_line_1: z.string().min(1).max(120),
		address_line_2: z.string().min(1).max(120).optional(),
		city: z.string().min(1).max(80),
		state_province_region: z.string().min(1).max(80),
		postal_code: z.string().min(1).max(20),
		country: z.string().regex(/^[A-Z]{2}$/),
		phone_number: z.string().min(1).max(30).optional(),
		id_doc_country: z.string().regex(/^[A-Z]{2}$/),
		id_doc_type: z.string().min(1).max(40),
		id_doc_front_file: z.string().url(),
		selfie_file: z.string().url(),
		proof_of_address_doc_type: z.string().min(1).max(40).optional(),
		proof_of_address_doc_file: z.string().url().optional(),
	})
	.strict();

export type BlindPayKycBody = z.infer<typeof BlindPayKycBodySchema>;

export const BlindPayTosBodySchema = z
	.object({
		tosId: z.string().min(1).max(80),
	})
	.strict();

export const BlindPayOnboardingRequestSchema = z
	.object({
		redirectUrl: z.string().url().optional(),
	})
	.strict();

/** What the sender must do before a sender-wallet quote is priced. */
export const BlindPayKycStepSchema = z.discriminatedUnion("step", [
	z
		.object({
			step: z.literal("accept_terms"),
			url: z.string().url(),
		})
		.strict(),
	z
		.object({
			step: z.literal("submit_kyc"),
		})
		.strict(),
	z
		.object({
			step: z.literal("wait_for_review"),
			kycStatus: z.string().min(1),
		})
		.strict(),
	z
		.object({
			step: z.literal("approved"),
			receiverId: z.string().min(1),
		})
		.strict(),
]);

export type BlindPayKycStep = z.infer<typeof BlindPayKycStepSchema>;

export const BlindPayOnboardingResponseSchema = z
	.object({
		receiverId: z.string().min(1).nullable(),
		kycStatus: z.string().min(1).nullable(),
		next: BlindPayKycStepSchema,
	})
	.strict();

export const BlindPayDelegationRequestSchema = z
	.object({
		ownerAddress: z.string().min(32).max(44),
	})
	.strict();

export const BlindPayDelegationResponseSchema = z
	.object({
		transaction: z.string().min(1),
		quoteId: z.string().min(1),
		expiresAt: IsoTimestamp,
		ownerAddress: z.string().min(32).max(44),
	})
	.strict();

export const BlindPayConfirmRequestSchema = z
	.object({
		signature: z.string().min(32).max(128),
	})
	.strict();

export const BlindPayConfirmResponseSchema = z.discriminatedUnion("status", [
	z
		.object({
			status: z.literal("accepted"),
			payoutId: z.string().min(1),
			paymentStatus: PaymentStatusSchema,
		})
		.strict(),
	z
		.object({
			status: z.literal("requote"),
			transaction: z.string().min(1),
			quoteId: z.string().min(1),
			expiresAt: IsoTimestamp,
		})
		.strict(),
]);

export type BlindPayDelegationResponse = z.infer<
	typeof BlindPayDelegationResponseSchema
>;
export type BlindPayConfirmResponse = z.infer<
	typeof BlindPayConfirmResponseSchema
>;
