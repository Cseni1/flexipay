import { z } from "zod";
import {
  DELIVERIES,
  ENDPOINT_TYPES,
  FEE_MODES,
  LEG_KINDS,
  LEG_STATUSES,
  PAYMENT_STATUSES,
  PRICE_RISK_BEARERS,
  PROFILES,
  RECIPIENT_KINDS,
} from "../enums.ts";
import { CurrencyCode, MoneySchema, RateString } from "../money.ts";

// Shared JSON shapes for the v1 HTTP contract (ARCHITECTURE §6, §7, §10). Money stays
// integer minor-unit strings with an explicit currency. Timestamps are ISO-8601 strings.

/** ISO country code, or empty string for crypto endpoints (§6.3). */
export const CountryCode = z.string().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2 country code");
export const CountryOrEmpty = z.union([CountryCode, z.literal("")]);

export const IsoTimestamp = z.string().datetime({ offset: true });

export const EndpointTypeSchema = z.enum(ENDPOINT_TYPES);
export const RecipientKindSchema = z.enum(RECIPIENT_KINDS);
export const LegKindSchema = z.enum(LEG_KINDS);
export const LegStatusSchema = z.enum(LEG_STATUSES);
export const PaymentStatusSchema = z.enum(PAYMENT_STATUSES);
export const DeliverySchema = z.enum(DELIVERIES);
export const ProfileSchema = z.enum(PROFILES);
export const PriceRiskBearerSchema = z.enum(PRICE_RISK_BEARERS);
/** Vault lock fee side (RULES.md / CCR-3). Required on settle quotes (CCR-8). */
export const FeeModeSchema = z.enum(FEE_MODES);

/** Provider or rail id from config (e.g. sim_bank_us_ach, stellar_usdc). */
export const RailId = z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case rail or provider id");

export const QuoteSourceSchema = z
  .object({
    type: EndpointTypeSchema,
    currency: CurrencyCode,
    country: CountryCode,
  })
  .strict();

export const QuoteDestinationSchema = z
  .object({
    type: EndpointTypeSchema,
    currency: CurrencyCode,
    country: CountryOrEmpty,
    recipientKind: RecipientKindSchema,
  })
  .strict();

export const QuoteAmountSchema = z
  .object({
    side: z.enum(["send", "receive"]),
    value: MoneySchema,
  })
  .strict();

/** One planned leg on a quote route (§6.4, §8). Amounts live in `fees` / `expectedReceive`. */
export const PlannedLegSchema = z
  .object({
    kind: LegKindSchema,
    rail: RailId,
    providerId: RailId,
    simulated: z.literal(true),
  })
  .strict();

export type PlannedLeg = z.infer<typeof PlannedLegSchema>;

/** Fee breakdown by leg plus the vault / FlexiPay fee (§6.4, CCR-3). */
export const FeeBreakdownSchema = z
  .object({
    legs: z.array(
      z
        .object({
          kind: LegKindSchema,
          rail: RailId,
          fee: MoneySchema,
        })
        .strict(),
    ),
    /** Vault fixed fee from `config()`; never a fees.json value (CCR-3). */
    flexiPayFee: MoneySchema,
    total: MoneySchema,
  })
  .strict();

export type FeeBreakdown = z.infer<typeof FeeBreakdownSchema>;

/** Other eligible routes with total cost and time (§6.4, §8). */
export const AlternativeRouteSchema = z
  .object({
    route: z.array(PlannedLegSchema).min(1),
    totalCost: MoneySchema,
    estimatedTimeSeconds: z.number().int().min(0),
    reasons: z.array(z.string().min(1)),
  })
  .strict();

export type AlternativeRoute = z.infer<typeof AlternativeRouteSchema>;

export const LegErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

/** Executed (or planned-on-payment) leg as returned by the API (§6.6). */
export const LegSchema = z
  .object({
    id: z.string().min(1),
    paymentId: z.string().min(1),
    kind: LegKindSchema,
    rail: RailId,
    providerId: RailId,
    amountIn: MoneySchema,
    amountOut: MoneySchema,
    status: LegStatusSchema,
    externalRef: z.string().min(1).nullable(),
    error: LegErrorSchema.nullable(),
    reversalOf: z.string().min(1).nullable(),
    simulated: z.boolean(),
  })
  .strict();

export type Leg = z.infer<typeof LegSchema>;

export { MoneySchema, RateString, CurrencyCode };
