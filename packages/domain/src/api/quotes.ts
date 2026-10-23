import { z } from "zod";
import {
  AlternativeRouteSchema,
  FeeBreakdownSchema,
  FeeModeSchema,
  IsoTimestamp,
  MoneySchema,
  PlannedLegSchema,
  PriceRiskBearerSchema,
  QuoteAmountSchema,
  QuoteDestinationSchema,
  QuoteSourceSchema,
  RateString,
} from "./common.ts";

// POST /v1/quotes (ARCHITECTURE §6.4, §8, §10). MVP policy is only `cheapest` (CCR-5 / §8).

export const CreateQuoteRequestSchema = z
  .object({
    source: QuoteSourceSchema,
    destination: QuoteDestinationSchema,
    amount: QuoteAmountSchema,
    /** Only `cheapest` is accepted in the MVP; any other value is a 422 (§8). */
    policy: z.literal("cheapest").default("cheapest"),
    /**
     * Vault FeeMode for settle routes (CCR-8). Required when the chosen route includes
     * settle; ignored for domestic / no-settle routes. No silent product default.
     */
    feeMode: FeeModeSchema.optional(),
  })
  .strict();

export type CreateQuoteRequest = z.infer<typeof CreateQuoteRequestSchema>;

export const QuoteSchema = z
  .object({
    id: z.string().min(1),
    source: QuoteSourceSchema,
    destination: QuoteDestinationSchema,
    amount: QuoteAmountSchema,
    route: z.array(PlannedLegSchema).min(1),
    fees: FeeBreakdownSchema,
    /** Decimal string, or null when the route converts nothing (§6.4). */
    fxRate: RateString.nullable(),
    expectedReceive: MoneySchema,
    priceRiskBearer: PriceRiskBearerSchema,
    policy: z.literal("cheapest"),
    /**
     * Echo of the vault FeeMode used to price settle (CCR-8). Null when the route has no
     * settle leg. Must be identical on payment create and SettlementAdapter.lock.
     */
    feeMode: FeeModeSchema.nullable(),
    validUntil: IsoTimestamp,
    alternatives: z.array(AlternativeRouteSchema),
    reasons: z.array(z.string().min(1)),
    simulated: z.literal(true),
  })
  .strict();

export type Quote = z.infer<typeof QuoteSchema>;
