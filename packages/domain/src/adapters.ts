import type { EndpointType, FeeMode, LegKind, SettlementNetwork } from "./enums.ts";
import type { Money } from "./money.ts";

// Adapter contracts (ARCHITECTURE §11.1, §11.2). Providers and networks are replaceable;
// the orchestrator only talks to these interfaces. Changes go through docs/CONTRACT_CHANGES.md.

// ---------- Provider adapter: bank, e-wallet, FX ----------

export interface ProviderCapabilities {
  providerId: string;
  countries: string[];
  currencies: string[];
  endpointTypes: EndpointType[];
  legKinds: LegKind[];
  /** null: no limit of its own. */
  limits: { min: Money; max: Money } | null;
  simulated: boolean;
}

/** The destination of a payout leg, masked details never leave the adapter. */
export interface EndpointRef {
  endpointId: string;
  type: EndpointType;
  country: string;
  currency: string;
}

export interface LegQuoteRequest {
  kind: LegKind;
  amountIn: Money;
  /** The currency this leg must deliver (differs from amountIn for convert). */
  outCurrency: string;
  endpoint?: EndpointRef;
}

export interface LegQuote {
  providerId: string;
  fee: Money;
  /** Decimal string, "out per 1 in"; null when the leg converts nothing. */
  fxRate: string | null;
  amountOut: Money;
  estimatedTimeSeconds: number;
  simulated: boolean;
}

export interface LegExecution extends LegQuoteRequest {
  paymentId: string;
  legId: string;
  /** 1 for the first try; a retry on the same provider increments it. */
  attempt: number;
}

export type ProviderLegStatus = "processing" | "succeeded" | "failed";

export interface ProviderLegState {
  status: ProviderLegStatus;
  externalRef: string;
  /** Set when status is failed. */
  error?: { code: string; message: string };
}

/**
 * Why a provider call is refused or a leg fails (CCR-4). `execute` and `reverse` throw
 * ProviderError only for requests that are invalid or not allowed; a leg that runs and then
 * fails is reported through `status()` with state `failed` and one of the failure codes.
 */
export const PROVIDER_ERROR_CODES = [
  "unsupported",
  "currency_mismatch",
  "below_min",
  "above_max",
  "fee_exceeds_amount",
  "no_fx_rate",
  "unknown_reference",
  "not_succeeded",
  "not_reversible",
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/** Codes a failed leg carries in `ProviderLegState.error.code`. */
export const LEG_FAILURE_CODES = ["sandbox_forced_failure", "provider_down"] as const;
export type LegFailureCode = (typeof LEG_FAILURE_CODES)[number];

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

/**
 * Sandbox controls behind /v1/sandbox/* (ARCHITECTURE §10). Implemented by the simulated
 * providers; the API calls them and never reaches into a provider.
 */
export interface SandboxControls {
  /** The next `count` execute() calls on this provider run and then fail (count defaults to 1). */
  failNext(providerId: string, count?: number): void;
  /** While on, every execute() on this provider fails until switched off (DF4: no alternative). */
  setForcedFailure(providerId: string, on: boolean): void;
  /**
   * Marks a provider up or down. Routing filters a down provider out at quote time; a leg that
   * runs on a provider marked down afterwards fails with `provider_down`.
   */
  setHealth(providerId: string, health: "up" | "down"): void;
  /** Clears every failure and health override. */
  reset(): void;
}

export interface ProviderAdapter {
  readonly id: string;
  capabilities(): ProviderCapabilities;
  quote(req: LegQuoteRequest): Promise<LegQuote>;
  /**
   * Starts the leg; returns the provider's external reference. Idempotent per (legId, attempt):
   * the same call returns the same reference and never changes the leg's state, including after
   * a failure or a reversal. A retry uses attempt + 1 and gets a new reference.
   */
  execute(leg: LegExecution): Promise<{ externalRef: string }>;
  status(externalRef: string): Promise<ProviderLegState>;
  /**
   * Reverses a succeeded `collect` or `convert` leg and returns the reversal's reference.
   * Idempotent: reversing the same reference again returns the same reversal reference.
   * Throws ProviderError `not_succeeded` for a leg that has not succeeded, `not_reversible`
   * for `payout` and `settle` legs, and `unknown_reference` for a reference it never issued.
   */
  reverse(externalRef: string): Promise<{ externalRef: string }>;
  health(): Promise<"up" | "down">;
}

// ---------- Settlement adapter: Stellar or mock ----------

/** Same rules, numbers and names as contracts/payout_vault/RULES.md. */
export const SETTLEMENT_ERROR_CODES = {
  1: "AlreadyInitialized",
  2: "NotInitialized",
  3: "InvalidAmount",
  4: "FeeTooHigh",
  5: "InsufficientBalance",
  6: "PayoutNotFound",
  7: "NotPending",
  8: "Expired",
  9: "NotExpired",
  10: "BadSecret",
  11: "InvalidExpiry",
  12: "DuplicateExternalId",
} as const;
export type SettlementErrorCode = keyof typeof SETTLEMENT_ERROR_CODES;
export type SettlementErrorName = (typeof SETTLEMENT_ERROR_CODES)[SettlementErrorCode];

export class SettlementError extends Error {
  readonly code: SettlementErrorCode;
  readonly errorName: SettlementErrorName;

  constructor(code: SettlementErrorCode, options?: { cause?: unknown }) {
    super(`settlement error #${code} ${SETTLEMENT_ERROR_CODES[code]}`, options);
    this.name = "SettlementError";
    this.code = code;
    this.errorName = SETTLEMENT_ERROR_CODES[code];
  }
}

/** A reference to an on-chain (or mock) transaction. */
export interface SettlementRef {
  network: SettlementNetwork;
  /** Stellar transaction hash, or a mock reference when network is "mock". */
  txRef: string;
}

export interface LockRequest {
  paymentId: string;
  /** Lock attempt, from 1; the on-chain id is sha256("<paymentId>:<attempt>"). */
  attempt: number;
  /** Address of the payer whose vault balance funds the lock. */
  payer: string;
  /** Gross amount in the settlement asset. */
  amount: Money;
  feeMode: FeeMode;
  expiresAt: Date;
  /** sha256 of the claim secret, hex. For direct delivery the backend holds the secret. */
  claimHashHex: string;
}

export interface LockResult extends SettlementRef {
  payoutId: string;
  externalIdHex: string;
  fee: Money;
  /** Taken from the payer's vault balance. */
  locked: Money;
  /** What the recipient will receive. */
  net: Money;
}

export interface ReleaseRequest {
  payoutId: string;
  /** The claim secret, hex. */
  secretHex: string;
  /** Receiving address; its owner authorises the claim. */
  destination: string;
}

export interface ReleaseResult extends SettlementRef {
  received: Money;
}

export type SettlementPayoutState = "pending" | "claimed" | "refunded";

export interface SettlementStatus {
  payoutId: string;
  state: SettlementPayoutState;
  expiresAt: Date;
  net: Money;
}

export interface SettlementAdapter {
  readonly network: SettlementNetwork;
  /** The vault's fixed fee in basis points, read from the contract (ARCHITECTURE §8). */
  feeBps(): Promise<number>;
  /** Moves the settlement asset into the payer's vault balance. */
  fundVault(payer: string, amount: Money): Promise<SettlementRef>;
  lock(req: LockRequest): Promise<LockResult>;
  release(req: ReleaseRequest): Promise<ReleaseResult>;
  /** Returns a pending payout to the payer: cancel before expiry, refund after it. */
  refund(payoutId: string): Promise<SettlementRef>;
  status(payoutId: string): Promise<SettlementStatus>;
  /** Recovers a lock after a lost response (RULES.md payout_by_external). */
  findLock(payer: string, paymentId: string, attempt: number): Promise<string | undefined>;
}
