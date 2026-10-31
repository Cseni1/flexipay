import { z } from "zod";
import {
	CountryOrEmpty,
	EndpointTypeSchema,
	IsoTimestamp,
} from "./common.ts";
import { CurrencyCode } from "../money.ts";

// POST/GET /v1/endpoints (CCR-16). Auth: api_key. details keys: CCR-17.

const detailString = z.string().min(1).max(200);

/**
 * Type-specific destination details (CCR-17). Only these keys are accepted;
 * values are opaque strings (synthetic demo values allowed).
 */
export function endpointDetailsSchemaFor(
	type: z.infer<typeof EndpointTypeSchema>,
): z.ZodType<Record<string, string>> {
	if (type === "bank_account") {
		return z
			.object({ accountNumber: detailString })
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
			ctx.addIssue({
				code: "custom",
				message: `details must match type ${ep.type} (CCR-17)`,
				path: ["details"],
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
