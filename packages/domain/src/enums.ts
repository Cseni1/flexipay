// Closed value sets from ARCHITECTURE §6, §7 and §8. "wallet" is never used on its own.

export const ENDPOINT_TYPES = ["bank_account", "ewallet", "crypto_wallet", "crypto_custodial"] as const;
export type EndpointType = (typeof ENDPOINT_TYPES)[number];

export const CRYPTO_ENDPOINT_TYPES: readonly EndpointType[] = ["crypto_wallet", "crypto_custodial"];
export const isCryptoEndpoint = (t: EndpointType): boolean => CRYPTO_ENDPOINT_TYPES.includes(t);

export const RECIPIENT_KINDS = ["individual", "company"] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

export const ORGANIZATION_KINDS = ["business", "individual"] as const;
export type OrganizationKind = (typeof ORGANIZATION_KINDS)[number];

export const LEG_KINDS = ["collect", "convert", "settle", "payout"] as const;
export type LegKind = (typeof LEG_KINDS)[number];

/** Provider kinds in the baseline (§11.1). The anchor kind is event work and is added then. */
export const PROVIDER_KINDS = ["bank", "ewallet", "fx"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PROFILES = ["small", "batch", "invoice", "tips", "domestic", "one_off"] as const;
export type Profile = (typeof PROFILES)[number];

export const DELIVERIES = ["direct", "claim_link"] as const;
export type Delivery = (typeof DELIVERIES)[number];

export const PAYMENT_STATUSES = [
  "quoted",
  "awaiting_funding",
  "funded",
  "processing",
  "paid",
  "cancelled",
  "failed",
  "refunding",
  "refunded",
  "expired",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const LEG_STATUSES = ["pending", "processing", "succeeded", "failed", "reversing", "reversed"] as const;
export type LegStatus = (typeof LEG_STATUSES)[number];

export const PRICE_RISK_BEARERS = ["sender", "recipient", "partner"] as const;
export type PriceRiskBearer = (typeof PRICE_RISK_BEARERS)[number];

export const ROUTING_POLICIES = ["cheapest", "fastest", "balanced"] as const;
export type RoutingPolicy = (typeof ROUTING_POLICIES)[number];

export const FEE_MODES = ["PayerPays", "RecipientPays"] as const;
export type FeeMode = (typeof FEE_MODES)[number];

export const SETTLEMENT_NETWORKS = ["stellar", "mock", "solana"] as const;
export type SettlementNetwork = (typeof SETTLEMENT_NETWORKS)[number];

/** Crypto rails on an Endpoint / claim accept body (CCR-24). Fiat keeps network null. */
export const CRYPTO_NETWORKS = ["stellar", "solana"] as const;
export type CryptoNetwork = (typeof CRYPTO_NETWORKS)[number];
