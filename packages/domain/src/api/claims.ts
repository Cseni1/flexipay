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
    network: z.enum(["stellar"]).nullable(),
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
    if (crypto && ep.network !== "stellar") {
      ctx.addIssue({
        code: "custom",
        message: "crypto endpoints set network to stellar (§6.3)",
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
// CCR-20 (ELFOGADÁSRA VÁR — not accepted): public passkey claim routes (M2).
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
     * are rejected on submit (CCR-20).
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
 * `Leg.releaseTxRef` is not yet written. No releaseTxRef field (ELFOGADÁSRA VÁR CCR-20).
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
