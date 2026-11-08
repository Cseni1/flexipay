import { z } from "zod";
import { CountryCode, IsoTimestamp, RecipientKindSchema } from "./common.ts";

/** Postal address for a partner beneficiary (CCR-43). `country` must match the recipient. */
export const RecipientAddressSchema = z
	.object({
		line1: z.string().min(1).max(200),
		line2: z.string().min(1).max(200).optional(),
		city: z.string().min(1).max(120),
		state: z.string().min(1).max(120),
		postalCode: z.string().min(1).max(32),
		country: CountryCode,
	})
	.strict();

export type RecipientAddress = z.infer<typeof RecipientAddressSchema>;

export const RecipientAddressResponseSchema = z
	.object({
		line1: z.string().min(1),
		line2: z.string().min(1).nullable(),
		city: z.string().min(1),
		state: z.string().min(1),
		postalCode: z.string().min(1),
		country: CountryCode,
	})
	.strict();

export const CreateRecipientRequestSchema = z
	.object({
		name: z.string().min(1).max(200),
		kind: RecipientKindSchema,
		country: CountryCode,
		address: RecipientAddressSchema.optional(),
	})
	.strict()
	.superRefine((body, ctx) => {
		if (body.address && body.address.country !== body.country) {
			ctx.addIssue({
				code: "custom",
				message: "address.country must match the recipient country",
				path: ["address", "country"],
			});
		}
	});

export type CreateRecipientRequest = z.infer<typeof CreateRecipientRequestSchema>;

export const RecipientSchema = z
	.object({
		id: z.string().min(1),
		name: z.string(),
		kind: RecipientKindSchema,
		country: z.string(),
		address: RecipientAddressResponseSchema.nullable(),
		createdAt: IsoTimestamp,
	})
	.strict();

export type Recipient = z.infer<typeof RecipientSchema>;

export const RecipientListResponseSchema = z
	.object({
		recipients: z.array(RecipientSchema),
	})
	.strict();
