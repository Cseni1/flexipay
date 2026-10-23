import { z } from "zod";
import {
  AlternativeRouteSchema,
  FeeBreakdownSchema,
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
    validUntil: IsoTimestamp,
    alternatives: z.array(AlternativeRouteSchema),
    reasons: z.array(z.string().min(1)),
    simulated: z.literal(true),
  })
  .strict();

export type Quote = z.infer<typeof QuoteSchema>;
