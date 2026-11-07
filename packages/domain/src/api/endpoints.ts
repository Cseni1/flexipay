import { z } from "zod";
import {
	CountryOrEmpty,
	EndpointTypeSchema,
	IsoTimestamp,
} from "./common.ts";
import { CurrencyCode } from "../money.ts";
import { electronicFormatIBAN, isValidBIC, isValidIBAN } from "ibantools";

// POST/GET /v1/endpoints (CCR-16). Auth: api_key. details keys: CCR-17.

const detailString = z.string().min(1).max(200);

/** IBAN checked with ibantools (country format + checksum); spaces allowed (platform tracker 2.6). */
const ibanString = detailString.refine(
	(v) => isValidIBAN(electronicFormatIBAN(v) ?? ""),
	{ message: "iban is not a valid IBAN (check the country code, length and check digits)" },
);
/** SWIFT/BIC: 8 or 11 characters, checked with ibantools. */
const bicString = detailString.refine(
	(v) => isValidBIC(v.replace(/\s+/g, "").toUpperCase()),
	{ message: "swiftCode is not a valid SWIFT/BIC (8 or 11 characters)" },
);

/**
 * Type-specific destination details (CCR-17). Only these keys are accepted;
 * values are opaque strings (synthetic demo values allowed).
 */
export function endpointDetailsSchemaFor(
	type: z.infer<typeof EndpointTypeSchema>,
): z.ZodType<Record<string, string>> {
	if (type === "bank_account") {
		// CCR-32: accountNumber stays required; these aid partner beneficiary creation.
		return z
			.object({
				accountNumber: detailString,
				accountHolderName: detailString.optional(),
				bankName: detailString.optional(),
				swiftCode: bicString.optional(),
				iban: ibanString.optional(),
				bankCode: detailString.optional(),
				branchCode: detailString.optional(),
				// CCR-34: BlindPay bank-account fields for BR, MX, CO and AR.
				pixKey: detailString.optional(),
				clabe: detailString.optional(),
				speiProtocol: detailString.optional(),
				speiInstitutionCode: detailString.optional(),
				firstName: detailString.optional(),
				lastName: detailString.optional(),
				documentId: detailString.optional(),
				documentType: detailString.optional(),
				email: detailString.optional(),
				accountType: detailString.optional(),
				transfersType: detailString.optional(),
			})
			.strict() as unknown as z.ZodType<Record<string, string>>;
	}
	if (type === "ewallet") {
		return z
			.object({ phoneNumber: detailString })
			.strict() as unknown as z.ZodType<Record<string, string>>;
	}
	// crypto_wallet | crypto_custodial
	return z
		.object({ address: detailString })
		.strict() as unknown as z.ZodType<Record<string, string>>;
}

export const CreateEndpointRequestSchema = z
	.object({
		recipientId: z.string().min(1),
		type: EndpointTypeSchema,
		country: CountryOrEmpty,
		currency: CurrencyCode,
		/** `stellar` | `solana` for crypto (CCR-24); null for fiat. */
		network: z.enum(["stellar", "solana"]).nullable(),
		details: z.record(z.string(), z.string()),
		simulated: z.literal(true),
	})
	.strict()
	.superRefine((ep, ctx) => {
		const crypto = ep.type === "crypto_wallet" || ep.type === "crypto_custodial";
		if (crypto && ep.country !== "") {
			ctx.addIssue({
				code: "custom",
				message: "crypto endpoints use an empty country (§6.3)",
				path: ["country"],
			});
		}
		if (crypto && ep.network !== "stellar" && ep.network !== "solana") {
			ctx.addIssue({
				code: "custom",
				message: "crypto endpoints set network to stellar or solana (CCR-24)",
				path: ["network"],
			});
		}
		if (!crypto && ep.network !== null) {
			ctx.addIssue({
				code: "custom",
				message: "non-crypto endpoints leave network null (§6.3)",
				path: ["network"],
			});
		}
		if (!crypto && ep.country === "") {
			ctx.addIssue({
				code: "custom",
				message: "fiat endpoints require a country (§6.3)",
				path: ["country"],
			});
		}
		const parsed = endpointDetailsSchemaFor(ep.type).safeParse(ep.details);
		if (!parsed.success) {
			// Name the bad field when it is a format check (IBAN, SWIFT/BIC); else the CCR-17 rule.
			const specific = parsed.error.issues.find((i) => i.code === "custom");
			ctx.addIssue({
				code: "custom",
				message: specific?.message ?? `details must match type ${ep.type} (CCR-17)`,
				path: ["details", ...(specific?.path ?? [])],
			});
		}
	});

export type CreateEndpointRequest = z.infer<typeof CreateEndpointRequestSchema>;

/**
 * Stored endpoint. `details` values are masked on read (API concern); keys stay CCR-17.
 */
export const EndpointSchema = z
	.object({
		id: z.string().min(1),
		organizationId: z.string().min(1),
		recipientId: z.string().min(1),
		type: EndpointTypeSchema,
		country: CountryOrEmpty,
		currency: CurrencyCode,
		network: z.enum(["stellar", "solana"]).nullable(),
		details: z.record(z.string(), z.string()),
		simulated: z.literal(true),
		createdAt: IsoTimestamp,
	})
	.strict();

export type Endpoint = z.infer<typeof EndpointSchema>;

export const EndpointListResponseSchema = z
	.object({
		endpoints: z.array(EndpointSchema),
	})
	.strict();

export type EndpointListResponse = z.infer<typeof EndpointListResponseSchema>;
