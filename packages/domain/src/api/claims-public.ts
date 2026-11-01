import { z } from "zod";
import {
  CountryOrEmpty,
  EndpointTypeSchema,
  IsoTimestamp,
  MoneySchema,
  PaymentStatusSchema,
} from "./common.ts";
import { CurrencyCode } from "../money.ts";
import { endpointDetailsSchemaFor } from "./endpoints.ts";

// GET/POST /v1/claims/{token} (ARCHITECTURE §6.7, §7, §10). Public routes (auth: none).

export const CLAIM_LINK_STATUSES = ["open", "accepted", "expired"] as const;
export type ClaimLinkStatus = (typeof CLAIM_LINK_STATUSES)[number];
export const ClaimLinkStatusSchema = z.enum(CLAIM_LINK_STATUSES);

/**
 * Public view of what is waiting for the recipient (SCENARIOS DF3 / ARCHITECTURE §10).
 * Amount is the expected receive side from the quote.
 */
/**
 * Optional on-chain evidence once the payment is paid (CCR-24 receiver UX).
 * Omitted while open/processing; never includes secrets.
 */
export const ClaimReleaseEvidenceSchema = z
  .object({
    network: z.enum(["solana", "stellar", "mock"]),
    signature: z.string().min(1),
    explorerUrl: z.string().min(1).optional(),
  })
  .strict();

export const ClaimViewSchema = z
  .object({
    paymentId: z.string().min(1),
    status: ClaimLinkStatusSchema,
    paymentStatus: PaymentStatusSchema,
    expiresAt: IsoTimestamp,
    amount: MoneySchema,
    corridor: z
      .object({
        from: z.object({ country: z.string(), currency: CurrencyCode }).strict(),
        to: z.object({ country: z.string(), currency: CurrencyCode }).strict(),
      })
      .strict(),
    allowedDestinationTypes: z.array(EndpointTypeSchema).min(1),
    simulated: z.literal(true),
    /** Present after backend-verified settle evidence (e.g. Solana signature). */
    releaseEvidence: ClaimReleaseEvidenceSchema.nullable().optional(),
  })
  .strict();

export type ClaimView = z.infer<typeof ClaimViewSchema>;

/**
 * Endpoint the recipient chooses on accept (§6.3). `details` keys are type-specific (CCR-17);
 * responses that echo endpoints must mask values (API implementation concern).
 */
export const ClaimAcceptEndpointSchema = z
  .object({
    type: EndpointTypeSchema,
    country: CountryOrEmpty,
    currency: CurrencyCode,
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
        message: "non-crypto endpoints leave network empty (§6.3)",
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

export const ClaimAcceptRequestSchema = z
  .object({
    endpoint: ClaimAcceptEndpointSchema,
  })
  .strict();

export type ClaimAcceptRequest = z.infer<typeof ClaimAcceptRequestSchema>;

/** Accept returns the updated claim view and the payment id now moving to paid/processing. */
export const ClaimAcceptResponseSchema = z
  .object({
    claim: ClaimViewSchema,
    paymentId: z.string().min(1),
    paymentStatus: PaymentStatusSchema,
  })
  .strict();

export type ClaimAcceptResponse = z.infer<typeof ClaimAcceptResponseSchema>;
