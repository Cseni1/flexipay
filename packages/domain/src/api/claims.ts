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

// ---------------------------------------------------------------------------
// CCR-21 (ELFOGADÁSRA VÁR — not accepted): public passkey claim routes (M2).
// auth: none. Wire encoding is exclusively base64 Stellar XDR (no alternate formats).
// authEntries / signedAuthEntries carry vault claim(id,secret,to) args — treat as secret.
// ---------------------------------------------------------------------------

/** Stellar contract address (C…, 56 chars). */
export const StellarContractIdSchema = z
  .string()
  .regex(/^C[A-Z0-9]{55}$/, "Stellar contract id C…");

/** Non-empty base64 (std or URL-safe) carrier; parse with stellar-sdk / passkey-kit. */
export const Base64XdrSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_+/=-]+$/, "base64 XDR");

export const PasskeyDeployRequestSchema = z
  .object({
    contractId: StellarContractIdSchema,
    /** WebAuthn credential id (base64url) from CreateWalletResult.keyIdBase64. */
    keyIdBase64: z.string().min(1),
    /**
     * CreateWalletResult.signedTx: base64 Transaction envelope XDR (shared-deployer
     * carrier; may lack a usable envelope source signature).
     */
    signedTx: Base64XdrSchema,
  })
  .strict();

export type PasskeyDeployRequest = z.infer<typeof PasskeyDeployRequestSchema>;

export const PasskeyDeployResponseSchema = z
  .object({
    contractId: StellarContractIdSchema,
    deployTxHash: z.string().regex(/^[a-f0-9]{64}$/, "lowercase hex tx hash"),
    creationLedger: z.number().int().nonnegative(),
    status: z.literal("deployed"),
  })
  .strict();

export type PasskeyDeployResponse = z.infer<typeof PasskeyDeployResponseSchema>;

export const PasskeyPrepareRequestSchema = z
  .object({
    contractId: StellarContractIdSchema,
  })
  .strict();

export type PasskeyPrepareRequest = z.infer<typeof PasskeyPrepareRequestSchema>;

export const PasskeyPrepareResponseSchema = z
  .object({
    prepareId: z.string().min(1),
    payoutId: z.string().min(1),
    networkPassphrase: z.string().min(1),
    /**
     * Sole allowed Soroban auth signatureExpirationLedger (u32) for every entry.
     * Client must pass this exact value to signAuthEntry; kit-default / other ledgers
     * are rejected on submit (CCR-21).
     */
    signatureExpirationLedger: z.number().int().positive(),
    /**
     * Unsigned SorobanAuthorizationEntry XDRs (base64), one per required C… auth.
     * SECRET-BEARING: rootInvocation includes vault claim secret bytes.
     * Never store plaintext in IdempotencyRecord.responseBody.
     */
    authEntries: z.array(Base64XdrSchema).min(1),
  })
  .strict();

export type PasskeyPrepareResponse = z.infer<typeof PasskeyPrepareResponseSchema>;

export const PasskeySubmitRequestSchema = z
  .object({
    prepareId: z.string().min(1),
    contractId: StellarContractIdSchema,
    /**
     * signAuthEntry results (base64), same length/order as prepare.authEntries.
     * Each entry's signatureExpirationLedger must equal prepare.signatureExpirationLedger.
     * SECRET-BEARING: same invocation args as unsigned entries.
     */
    signedAuthEntries: z.array(Base64XdrSchema).min(1),
  })
  .strict();

export type PasskeySubmitRequest = z.infer<typeof PasskeySubmitRequestSchema>;

/**
 * HTTP 200 only after the release tx is RPC-SUCCESS and settle `Leg.releaseTxRef` is written.
 * Never return this shape (and never require releaseTxRef) while the tx is PENDING / unknown.
 */
export const PasskeySubmitResponseSchema = z
  .object({
    claim: ClaimViewSchema,
    paymentId: z.string().min(1),
    paymentStatus: PaymentStatusSchema,
    /**
     * Settle leg `Leg.releaseTxRef` (CCR-12). Sole success tx ref for the release;
     * not a separate prepare-row hash.
     */
    releaseTxRef: z.string().min(1),
  })
  .strict();

export type PasskeySubmitResponse = z.infer<typeof PasskeySubmitResponseSchema>;

/**
 * HTTP 202 — release envelope was persisted/sent (or is awaiting confirmation) but
 * `Leg.releaseTxRef` is not yet written. No releaseTxRef field (ELFOGADÁSRA VÁR CCR-21).
 * Client polls GET /v1/claims/{token} or retries submit with the same Idempotency-Key.
 */
export const PasskeySubmitPendingResponseSchema = z
  .object({
    status: z.literal("pending"),
    prepareId: z.string().min(1),
    paymentId: z.string().min(1),
    paymentStatus: PaymentStatusSchema,
    /** Same hash as PasskeyClaimPrepare.pendingTxHash; not a success release ref. */
    pendingTxHash: z.string().regex(/^[a-f0-9]{64}$/, "lowercase hex tx hash"),
  })
  .strict();

export type PasskeySubmitPendingResponse = z.infer<
  typeof PasskeySubmitPendingResponseSchema
>;

// ---------------------------------------------------------------------------
// CCR-22: public claim-link reference-anchor HTTP (M1). auth: none.
// Adapter surface remains CCR-20 (ReferenceAnchorClient). Indicative ≠ binding quote.
// interactiveUrl: first successful withdraw response only — never DB/log/event/idempotency cache.
// ---------------------------------------------------------------------------

const USDC_DECIMALS = 7n;
const USDC_MAJOR_SCALE = 10n ** USDC_DECIMALS;
const ANCHOR_MIN_MINOR = 1n * USDC_MAJOR_SCALE;
const ANCHOR_MAX_MINOR = 10n * USDC_MAJOR_SCALE;

/** Parse SEP major-unit decimal → USDC minor units (integer; no float). */
export function anchorMajorToMinor(major: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(major.trim());
  if (!m) throw new Error("invalid major units");
  const whole = BigInt(m[1]!);
  const frac = (m[2] ?? "").padEnd(Number(USDC_DECIMALS), "0");
  return whole * USDC_MAJOR_SCALE + BigInt(frac || "0");
}

/** Format USDC minor units → SEP major-unit decimal string (no float). */
export function anchorMinorToMajor(minor: string | bigint): string {
  const m = typeof minor === "bigint" ? minor : BigInt(minor);
  if (m < 0n) throw new Error("negative minor units");
  const whole = m / USDC_MAJOR_SCALE;
  const frac = m % USDC_MAJOR_SCALE;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(Number(USDC_DECIMALS), "0").replace(/0+$/, "")}`;
}

/**
 * USDC major units as a decimal string in [1, 10] (CCR-22 anchor limit).
 * Integer minor-unit check — not Number()/float.
 */
export const AnchorUsdcMajorAmountSchema = z
  .string()
  .regex(/^\d+(\.\d{1,7})?$/, "decimal major units")
  .refine((s) => {
    try {
      const minor = anchorMajorToMinor(s);
      return minor >= ANCHOR_MIN_MINOR && minor <= ANCHOR_MAX_MINOR;
    } catch {
      return false;
    }
  }, "USDC major units must be between 1 and 10");

export const AnchorIndicativePriceRequestSchema = z
  .object({
    sellAmount: AnchorUsdcMajorAmountSchema,
  })
  .strict();

export type AnchorIndicativePriceRequest = z.infer<
  typeof AnchorIndicativePriceRequestSchema
>;

export const AnchorIndicativePriceResponseSchema = z
  .object({
    indicative: z.literal(true),
    context: z.literal("sep6"),
    sellAmount: z.string().min(1),
    buyAmount: z.string().min(1),
    buyAsset: z.string().min(1),
    sellAsset: z.string().min(1),
    price: z.string().min(1),
  })
  .strict();

export type AnchorIndicativePriceResponse = z.infer<
  typeof AnchorIndicativePriceResponseSchema
>;

export const AnchorWithdrawRequestSchema = z
  .object({
    /**
     * Optional USDC major units. Default = claim settle net (capped by anchor 1–10).
     * Must not exceed claim net; must satisfy anchor limits when present.
     */
    amount: AnchorUsdcMajorAmountSchema.optional(),
    /** Only `bank_account` or omitted (CCR-22). */
    type: z.enum(["bank_account"]).optional(),
  })
  .strict();

export type AnchorWithdrawRequest = z.infer<typeof AnchorWithdrawRequestSchema>;

/**
 * First successful withdraw may include `interactiveUrl` (server→client once).
 * Replay/resume omits it — urlSanitised only. Never persist interactiveUrl.
 */
export const AnchorWithdrawResponseSchema = z
  .object({
    anchorTxId: z.string().min(1),
    urlSanitised: z.string().min(1),
    interactiveUrl: z.string().min(1).optional(),
    kind: z.literal("withdrawal"),
  })
  .strict();

export type AnchorWithdrawResponse = z.infer<typeof AnchorWithdrawResponseSchema>;

/**
 * Read-only SEP-24 status. Separate refs — do not conflate hashes:
 * vaultReleaseTxRef, anchorPaymentTxHash (our classic pay), anchorStellarTransactionId (anchor).
 */
export const AnchorWithdrawStatusResponseSchema = z
  .object({
    anchorTxId: z.string().min(1),
    status: z.string().min(1),
    amountIn: z.string().min(1).optional(),
    withdrawAnchorAccount: z.string().min(1).optional(),
    withdrawMemoPresent: z.boolean(),
    anchorPaymentTxHash: z.string().min(1).optional(),
    anchorStellarTransactionId: z.string().min(1).optional(),
    vaultReleaseTxRef: z.string().min(1).optional(),
    terminal: z.boolean(),
  })
  .strict();

export type AnchorWithdrawStatusResponse = z.infer<
  typeof AnchorWithdrawStatusResponseSchema
>;

/** POST …/pay — empty body; Idempotency-Key required. */
export const AnchorPayRequestSchema = z.object({}).strict();

export type AnchorPayRequest = z.infer<typeof AnchorPayRequestSchema>;

export const AnchorPayResponseSchema = z
  .object({
    status: z.literal("submitted"),
    anchorTxId: z.string().min(1),
    /** Our classic memo payment hash (pre-submit retained). */
    anchorPaymentTxHash: z.string().regex(/^[a-f0-9]{64}$/, "lowercase hex tx hash"),
  })
  .strict();

export type AnchorPayResponse = z.infer<typeof AnchorPayResponseSchema>;

/**
 * 202 — envelope persisted / submit uncertain; Leg/claim payment hash not final.
 * NOT_FOUND/timeout never authorises a new payment — same envelope only.
 */
export const AnchorPayPendingResponseSchema = z
  .object({
    status: z.literal("pending"),
    anchorTxId: z.string().min(1),
    pendingTxHash: z.string().regex(/^[a-f0-9]{64}$/, "lowercase hex tx hash"),
  })
  .strict();

export type AnchorPayPendingResponse = z.infer<
  typeof AnchorPayPendingResponseSchema
>;
