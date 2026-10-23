import { z } from "zod";
import {
  DeliverySchema,
  IsoTimestamp,
  LegSchema,
  PaymentStatusSchema,
  ProfileSchema,
} from "./common.ts";
import { EventSchema } from "./events.ts";
import { QuoteSchema } from "./quotes.ts";

// POST/GET /v1/payments and /v1/payments/{id} (ARCHITECTURE §6.5, §6.6, §7, §10).

export const CreatePaymentRequestSchema = z
  .object({
    quoteId: z.string().min(1),
    recipientId: z.string().min(1),
    /** Client's own id; duplicates for the same organization are 409 (§7). */
    externalId: z.string().min(1).max(200).optional(),
    delivery: DeliverySchema,
    profile: ProfileSchema,
    reference: z.string().min(1).max(200).optional(),
  })
  .strict();

export type CreatePaymentRequest = z.infer<typeof CreatePaymentRequestSchema>;

/**
 * Claim link handle returned only for `delivery: claim_link`. The raw token appears only in
 * the URL (§6.7); it is never stored in clear text.
 */
export const ClaimLinkHandleSchema = z
  .object({
    url: z.string().min(1),
    expiresAt: IsoTimestamp,
  })
  .strict();

export type ClaimLinkHandle = z.infer<typeof ClaimLinkHandleSchema>;

export const PaymentSchema = z
  .object({
    id: z.string().min(1),
    organizationId: z.string().min(1),
    quoteId: z.string().min(1),
    recipientId: z.string().min(1),
    externalId: z.string().min(1).nullable(),
    delivery: DeliverySchema,
    profile: ProfileSchema,
    reference: z.string().min(1).nullable(),
    status: PaymentStatusSchema,
    batchId: z.string().min(1).nullable(),
    legs: z.array(LegSchema),
    claimLink: ClaimLinkHandleSchema.nullable(),
    createdAt: IsoTimestamp,
    updatedAt: IsoTimestamp,
  })
  .strict();

export type Payment = z.infer<typeof PaymentSchema>;

/** GET /v1/payments — list without requiring the full event log. */
export const PaymentListResponseSchema = z
  .object({
    payments: z.array(PaymentSchema),
  })
  .strict();

export type PaymentListResponse = z.infer<typeof PaymentListResponseSchema>;

/** GET /v1/payments/{id} — payment with legs and timeline events (§10). */
export const PaymentDetailSchema = PaymentSchema.extend({
  quote: QuoteSchema.optional(),
  events: z.array(EventSchema),
}).strict();

export type PaymentDetail = z.infer<typeof PaymentDetailSchema>;
