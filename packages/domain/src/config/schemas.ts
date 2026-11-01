import { z } from "zod";
import {
  ENDPOINT_TYPES,
  LEG_KINDS,
  PRICE_RISK_BEARERS,
  PROVIDER_KINDS,
  RECIPIENT_KINDS,
} from "../enums.ts";
import { CurrencyCode, MoneySchema, RateString } from "../money.ts";

// Shapes of config/corridors.json, config/providers.json and config/fees.json
// (ARCHITECTURE §6.8, §8, §11.1; CCR-3). Countries, rails and providers are configuration,
// not code. Every configurable number in an entry with `placeholder: true` is a placeholder,
// never a real price, and the UI labels it so.

const Id = z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case id");
const CountryCode = z.string().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2 country code");
const Bps = z.number().int().min(0).max(10_000);

const EndpointType = z.enum(ENDPOINT_TYPES);
const RecipientKind = z.enum(RECIPIENT_KINDS);
const LegKind = z.enum(LEG_KINDS);

export const LimitSchema = z.object({ min: MoneySchema, max: MoneySchema }).strict();

const PerRecipientKind = <T extends z.ZodType>(item: T) =>
  z.object({ individual: item, company: item }).strict();

export const CorridorSchema = z
  .object({
    from: z.object({ country: CountryCode, currency: CurrencyCode }).strict(),
    to: z.object({ country: CountryCode, currency: CurrencyCode }).strict(),
    allowedDestinationTypes: z.array(EndpointType).min(1),
    recipientKinds: z.array(RecipientKind).min(1),
    cryptoLegAllowed: PerRecipientKind(z.boolean()),
    /** Send-side limits, in the corridor's `from` currency (CCR-3). */
    limits: PerRecipientKind(LimitSchema),
    /** Provider or rail ids per leg kind; an empty list is a confirmed absence. */
    legsAvailable: z
      .object({
        collect: z.array(Id),
        convert: z.array(Id),
        settle: z.array(Id),
        payout: z.array(Id),
      })
      .strict(),
    /** Provider id when from and to are the same country, otherwise null. */
    domesticRail: Id.nullable(),
    /** Short text for the (i) popover. */
    regulationNote: z.string().min(1).max(500),
    simulated: z.boolean(),
    placeholder: z.boolean(),
  })
  .strict();
export type Corridor = z.infer<typeof CorridorSchema>;

export const ProviderSchema = z
  .object({
    id: Id,
    kind: z.enum(PROVIDER_KINDS),
    countries: z.array(CountryCode).min(1),
    currencies: z.array(CurrencyCode).min(1),
    /** Empty for providers that serve no endpoint (the FX conversion leg). */
    endpointTypes: z.array(EndpointType),
    legKinds: z.array(LegKind).min(1),
    fee: z.object({ fixed: MoneySchema, bps: Bps }).strict(),
    fxSpreadBps: Bps,
    estimatedTimeSeconds: z.number().int().min(0),
    /** null: the provider has no limit of its own (not a zero limit). */
    limits: LimitSchema.nullable(),
    simulated: z.boolean(),
    placeholder: z.boolean(),
  })
  .strict();
export type Provider = z.infer<typeof ProviderSchema>;

/**
 * A settlement rail used by the `settle` leg. Holds no issuer, vault id, passphrase or fee:
 * those come from the FP_ settings and the vault's config() (ARCHITECTURE §8, §12).
 */
export const SettlementRailSchema = z
  .object({
    id: Id,
    /** CCR-24: stellar vault rail or solana USDC rail. */
    network: z.enum(["stellar", "solana"]),
    asset: CurrencyCode,
    simulated: z.boolean(),
  })
  .strict();
export type SettlementRail = z.infer<typeof SettlementRailSchema>;

/** Simulated conversion rate for one direction (CCR-4). Never derived by inverting another entry. */
export const FxRateSchema = z
  .object({ from: CurrencyCode, to: CurrencyCode, rate: RateString, placeholder: z.boolean() })
  .strict();
export type FxRate = z.infer<typeof FxRateSchema>;

export const CorridorsFileSchema = z.object({ corridors: z.array(CorridorSchema).min(1) }).strict();

export const ProvidersFileSchema = z
  .object({
    providers: z.array(ProviderSchema).min(1),
    settlementRails: z.array(SettlementRailSchema),
    fxRates: z.array(FxRateSchema),
  })
  .strict();

/**
 * Fees outside the vault live on the providers. For vault-settled routes the FlexiPay fee is the
 * vault's fixed fee read from config(), so there is deliberately no vault fee field here.
 */
export const FeesFileSchema = z
  .object({
    quoteValiditySeconds: z.number().int().min(1),
    priceRiskBearer: z.enum(PRICE_RISK_BEARERS),
    tipsFeeBps: Bps,
    placeholder: z.boolean(),
  })
  .strict();
export type FeesConfig = z.infer<typeof FeesFileSchema>;

export interface FlexiPayConfig {
  corridors: Corridor[];
  providers: Provider[];
  settlementRails: SettlementRail[];
  fxRates: FxRate[];
  fees: FeesConfig;
}
