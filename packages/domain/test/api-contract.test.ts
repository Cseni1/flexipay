import { describe, expect, it } from "vitest";
import {
  A0_OPENAPI_STUBS,
  ClaimAcceptRequestSchema,
  ClaimViewSchema,
  CreateBatchRequestSchema,
  CreateEndpointRequestSchema,
  CreatePaymentRequestSchema,
  CreateQuoteRequestSchema,
  EVENT_TYPES,
  EventSchema,
  PasskeyDeployRequestSchema,
  PasskeyDeployResponseSchema,
  PasskeyPrepareRequestSchema,
  PasskeyPrepareResponseSchema,
  PasskeySubmitRequestSchema,
  PasskeySubmitResponseSchema,
  PaymentDetailSchema,
  PaymentSchema,
  QuoteSchema,
  SandboxAdvanceTimeRequestSchema,
  SandboxAdvanceTimeResponseSchema,
  SandboxFailNextRequestSchema,
} from "../src/index.ts";

const T0 = "2026-10-22T12:00:00.000Z";
const T1 = "2026-10-22T12:02:00.000Z";

const moneyUsd = (amount: string) => ({ amount, currency: "USD" as const });
const moneyPhp = (amount: string) => ({ amount, currency: "PHP" as const });

const validQuote = {
  id: "quo_demo_1",
  source: { type: "bank_account" as const, currency: "USD", country: "US" },
  destination: {
    type: "bank_account" as const,
    currency: "PHP",
    country: "PH",
    recipientKind: "individual" as const,
  },
  amount: { side: "send" as const, value: moneyUsd("10000") },
  route: [
    {
      kind: "collect" as const,
      rail: "sim_bank_us_ach",
      providerId: "sim_bank_us_ach",
      amountIn: moneyUsd("10000"),
      amountOut: moneyUsd("10000"),
      simulated: true as const,
    },
    {
      kind: "convert" as const,
      rail: "sim_fx",
      providerId: "sim_fx",
      amountIn: moneyUsd("10000"),
      amountOut: moneyUsd("10000"),
      simulated: true as const,
    },
    {
      kind: "settle" as const,
      rail: "stellar_usdc",
      providerId: "stellar_usdc",
      amountIn: moneyUsd("10000"),
      amountOut: moneyUsd("10000"),
      simulated: true as const,
    },
    {
      kind: "convert" as const,
      rail: "sim_fx",
      providerId: "sim_fx",
      amountIn: moneyUsd("10000"),
      amountOut: moneyPhp("560000"),
      simulated: true as const,
    },
    {
      kind: "payout" as const,
      rail: "sim_bank_ph_instapay",
      providerId: "sim_bank_ph_instapay",
      amountIn: moneyPhp("560000"),
      amountOut: moneyPhp("560000"),
      simulated: true as const,
    },
  ],
  fees: {
    legs: [
      { kind: "collect" as const, rail: "sim_bank_us_ach", fee: moneyUsd("0") },
      { kind: "convert" as const, rail: "sim_fx", fee: moneyUsd("50") },
      { kind: "settle" as const, rail: "stellar_usdc", fee: moneyUsd("100") },
      { kind: "convert" as const, rail: "sim_fx", fee: moneyUsd("0") },
      { kind: "payout" as const, rail: "sim_bank_ph_instapay", fee: moneyUsd("0") },
    ],
    flexiPayFee: moneyUsd("100"),
    total: moneyUsd("250"),
    settleUnlockedRemainder: null,
  },
  fxRate: "56.0000000",
  expectedReceive: moneyPhp("560000"),
  priceRiskBearer: "sender" as const,
  policy: "cheapest" as const,
  feeMode: "RecipientPays" as const,
  validUntil: T1,
  alternatives: [],
  reasons: ["Cheapest eligible route for this corridor"],
  simulated: true as const,
};

describe("A0 CreateQuoteRequestSchema", () => {
  it("accepts a documented quote request", () => {
    const parsed = CreateQuoteRequestSchema.parse({
      source: validQuote.source,
      destination: validQuote.destination,
      amount: validQuote.amount,
    });
    expect(parsed.policy).toBe("cheapest");
  });

  it("rejects float money, unknown policy and extra fields", () => {
    expect(
      CreateQuoteRequestSchema.safeParse({
        source: validQuote.source,
        destination: validQuote.destination,
        amount: { side: "send", value: { amount: "10.5", currency: "USD" } },
      }).success,
    ).toBe(false);
    expect(
      CreateQuoteRequestSchema.safeParse({
        source: validQuote.source,
        destination: validQuote.destination,
        amount: validQuote.amount,
        policy: "fastest",
      }).success,
    ).toBe(false);
    expect(
      CreateQuoteRequestSchema.safeParse({
        source: validQuote.source,
        destination: validQuote.destination,
        amount: validQuote.amount,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("accepts optional feeMode PayerPays | RecipientPays (CCR-8)", () => {
    const withMode = CreateQuoteRequestSchema.parse({
      source: validQuote.source,
      destination: validQuote.destination,
      amount: validQuote.amount,
      feeMode: "PayerPays",
    });
    expect(withMode.feeMode).toBe("PayerPays");
    expect(
      CreateQuoteRequestSchema.safeParse({
        source: validQuote.source,
        destination: validQuote.destination,
        amount: validQuote.amount,
        feeMode: "SplitEvenly",
      }).success,
    ).toBe(false);
  });
});

describe("A0 QuoteSchema", () => {
  it("accepts a full quote response", () => {
    expect(QuoteSchema.parse(validQuote).id).toBe("quo_demo_1");
    expect(QuoteSchema.parse(validQuote).feeMode).toBe("RecipientPays");
  });

  it("allows feeMode null for no-settle routes", () => {
    expect(QuoteSchema.parse({ ...validQuote, feeMode: null }).feeMode).toBeNull();
  });

  it("rejects a quote marked simulated:false", () => {
    expect(QuoteSchema.safeParse({ ...validQuote, simulated: false }).success).toBe(false);
  });
});

describe("A0 payment schemas", () => {
  const payment = {
    id: "pay_demo_1",
    organizationId: "org_demo",
    quoteId: "quo_demo_1",
    recipientId: "rcp_worker_a",
    externalId: "client-ext-1",
    delivery: "direct" as const,
    profile: "one_off" as const,
    reference: null,
    status: "awaiting_funding" as const,
    batchId: null,
    legs: [],
    claimLink: null,
    createdAt: T0,
    updatedAt: T0,
  };

  it("accepts create and payment bodies", () => {
    expect(
      CreatePaymentRequestSchema.parse({
        quoteId: "quo_demo_1",
        recipientId: "rcp_worker_a",
        delivery: "direct",
        profile: "one_off",
        externalId: "client-ext-1",
      }).externalId,
    ).toBe("client-ext-1");
    expect(PaymentSchema.parse(payment).status).toBe("awaiting_funding");
  });

  it("rejects undocumented payment status and float leg amounts", () => {
    expect(PaymentSchema.safeParse({ ...payment, status: "settling" }).success).toBe(false);
    expect(
      PaymentDetailSchema.safeParse({
        ...payment,
        events: [],
        legs: [
          {
            id: "leg_1",
            paymentId: "pay_demo_1",
            kind: "collect",
            rail: "sim_bank_us_ach",
            providerId: "sim_bank_us_ach",
            amountIn: { amount: "10.00", currency: "USD" },
            amountOut: moneyUsd("10000"),
            status: "pending",
            attempt: 1,
            externalRef: null,
            lockTxRef: null,
            releaseTxRef: null,
            error: null,
            reversalOf: null,
            simulated: true,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("PaymentDetail is payment plus events only (no embedded quote)", () => {
    const detail = PaymentDetailSchema.parse({ ...payment, events: [] });
    expect(detail).not.toHaveProperty("quote");
    expect(
      PaymentDetailSchema.safeParse({
        ...payment,
        events: [],
        quote: validQuote,
      }).success,
    ).toBe(false);
  });
});

describe("A0 claim and event schemas", () => {
  it("accepts a public claim view and a crypto accept body", () => {
    const view = ClaimViewSchema.parse({
      paymentId: "pay_demo_1",
      status: "open",
      paymentStatus: "processing",
      expiresAt: T1,
      amount: moneyPhp("560000"),
      corridor: {
        from: { country: "US", currency: "USD" },
        to: { country: "PH", currency: "PHP" },
      },
      allowedDestinationTypes: ["crypto_wallet"],
      simulated: true,
    });
    expect(view.status).toBe("open");

    expect(
      ClaimAcceptRequestSchema.parse({
        endpoint: {
          type: "crypto_wallet",
          country: "",
          currency: "USDC",
          network: "stellar",
          details: { address: "GDEMORECIPIENT0000000000000000000000000000000000000" },
          simulated: true,
        },
      }).endpoint.type,
    ).toBe("crypto_wallet");
  });

  it("accepts fiat claim details under CCR-17 and rejects empty country / wrong keys", () => {
    expect(
      ClaimAcceptRequestSchema.parse({
        endpoint: {
          type: "bank_account",
          country: "PH",
          currency: "PHP",
          network: null,
          details: { accountNumber: "****1234" },
          simulated: true,
        },
      }).endpoint.details.accountNumber,
    ).toBe("****1234");
    expect(
      ClaimAcceptRequestSchema.safeParse({
        endpoint: {
          type: "bank_account",
          country: "",
          currency: "PHP",
          network: null,
          details: { accountNumber: "****1234" },
          simulated: true,
        },
      }).success,
    ).toBe(false);
    expect(
      ClaimAcceptRequestSchema.safeParse({
        endpoint: {
          type: "ewallet",
          country: "PH",
          currency: "PHP",
          network: null,
          details: { syntheticRef: "demo" },
          simulated: true,
        },
      }).success,
    ).toBe(false);
    expect(
      EventSchema.safeParse({
        id: "evt_1",
        type: "payment.unknown",
        createdAt: T0,
        paymentId: "pay_demo_1",
        snapshot: {},
      }).success,
    ).toBe(false);
    expect(EVENT_TYPES).toContain("payment.onchain");
  });
});

describe("A0 endpoint and batch schemas (CCR-16/18)", () => {
  it("accepts create-endpoint and create-batch bodies", () => {
    expect(
      CreateEndpointRequestSchema.parse({
        recipientId: "rcp_1",
        type: "ewallet",
        country: "PH",
        currency: "PHP",
        network: null,
        details: { phoneNumber: "+63000000000" },
        simulated: true,
      }).type,
    ).toBe("ewallet");
    expect(
      CreateBatchRequestSchema.parse({
        feeMode: "PayerPays",
        rows: [
          {
            recipientId: "rcp_1",
            endpointId: "ep_1",
            amount: moneyUsd("10000"),
            externalId: "batch-row-1",
            profile: "batch",
          },
        ],
      }).rows,
    ).toHaveLength(1);
  });
});

describe("A0 sandbox schemas", () => {
  it("accepts fail-next shaped from ARCHITECTURE §10 and CCR-4", () => {
    expect(
      SandboxFailNextRequestSchema.parse({ providerId: "sim_bank_br_pix", count: 1 }).count,
    ).toBe(1);
  });

  it("contracts CCR-6 advance-time request/response; other sandbox stubs stay body-only", () => {
    expect(SandboxAdvanceTimeRequestSchema.parse({ seconds: 60 }).seconds).toBe(60);
    expect(
      SandboxAdvanceTimeResponseSchema.parse({ now: T1 }).now,
    ).toBe(T1);
    const sandbox = A0_OPENAPI_STUBS.filter((s) => s.path.startsWith("/v1/sandbox/"));
    expect(sandbox.map((s) => s.path).sort()).toEqual(
      [
        "/v1/sandbox/advance-time",
        "/v1/sandbox/fail-next",
        "/v1/sandbox/provider-health",
        "/v1/sandbox/reset",
      ].sort(),
    );
    const advance = sandbox.find((s) => s.path === "/v1/sandbox/advance-time");
    expect(advance?.body).toBe(SandboxAdvanceTimeRequestSchema);
    expect(advance?.success.schema).toBe(SandboxAdvanceTimeResponseSchema);
    for (const s of sandbox.filter((x) => x.path !== "/v1/sandbox/advance-time")) {
      expect(s.success.schema).toBeUndefined();
    }
  });
});

describe("CCR-20 passkey claim schemas (ELFOGADÁSRA VÁR)", () => {
  const contractId = "C" + "A".repeat(55);
  const fakeXdr = "AAAAAgAAAAA="; // non-empty base64 placeholder (not a real envelope)

  it("accepts deploy / prepare / submit request and response shapes", () => {
    expect(
      PasskeyDeployRequestSchema.parse({
        contractId,
        keyIdBase64: "dGVzdC1rZXk",
        signedTx: fakeXdr,
      }).contractId,
    ).toBe(contractId);
    expect(
      PasskeyDeployResponseSchema.parse({
        contractId,
        deployTxHash: "a".repeat(64),
        creationLedger: 1,
        status: "deployed",
      }).status,
    ).toBe("deployed");

    expect(PasskeyPrepareRequestSchema.parse({ contractId }).contractId).toBe(
      contractId,
    );
    const prepared = PasskeyPrepareResponseSchema.parse({
      prepareId: "ppk_1",
      payoutId: "1",
      networkPassphrase: "Test SDF Network ; September 2015",
      signatureExpirationLedger: 4_500_000,
      authEntries: [fakeXdr],
    });
    expect(prepared.authEntries).toHaveLength(1);

    expect(
      PasskeySubmitRequestSchema.parse({
        prepareId: "ppk_1",
        contractId,
        signedAuthEntries: [fakeXdr],
      }).prepareId,
    ).toBe("ppk_1");
    expect(
      PasskeySubmitResponseSchema.parse({
        claim: {
          paymentId: "pay_demo_1",
          status: "accepted",
          paymentStatus: "paid",
          expiresAt: T1,
          amount: moneyPhp("560000"),
          corridor: {
            from: { country: "US", currency: "USD" },
            to: { country: "PH", currency: "PHP" },
          },
          allowedDestinationTypes: ["crypto_wallet"],
          simulated: true,
        },
        paymentId: "pay_demo_1",
        paymentStatus: "paid",
        releaseTxRef: "b".repeat(64),
      }).releaseTxRef,
    ).toBe("b".repeat(64));
  });

  it("rejects invalid contract ids, empty XDR, secretHex, and legacy releaseTxHash", () => {
    expect(
      PasskeyDeployRequestSchema.safeParse({
        contractId: "G" + "A".repeat(55),
        keyIdBase64: "dGVzdC1rZXk",
        signedTx: fakeXdr,
      }).success,
    ).toBe(false);
    expect(
      PasskeyPrepareResponseSchema.safeParse({
        prepareId: "ppk_1",
        payoutId: "1",
        networkPassphrase: "Test SDF Network ; September 2015",
        signatureExpirationLedger: 1,
        authEntries: [],
      }).success,
    ).toBe(false);
    expect(
      PasskeySubmitRequestSchema.safeParse({
        prepareId: "ppk_1",
        contractId,
        signedAuthEntries: [fakeXdr],
        secretHex: "deadbeef",
      }).success,
    ).toBe(false);
    expect(
      PasskeyPrepareResponseSchema.safeParse({
        prepareId: "ppk_1",
        payoutId: "1",
        networkPassphrase: "Test SDF Network ; September 2015",
        signatureExpirationLedger: 1,
        authEntries: [fakeXdr],
        secretHex: "deadbeef",
      }).success,
    ).toBe(false);
    expect(
      PasskeySubmitResponseSchema.safeParse({
        claim: {
          paymentId: "pay_demo_1",
          status: "accepted",
          paymentStatus: "paid",
          expiresAt: T1,
          amount: moneyPhp("560000"),
          corridor: {
            from: { country: "US", currency: "USD" },
            to: { country: "PH", currency: "PHP" },
          },
          allowedDestinationTypes: ["crypto_wallet"],
          simulated: true,
        },
        paymentId: "pay_demo_1",
        paymentStatus: "paid",
        releaseTxHash: "b".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      PasskeyPrepareResponseSchema.parse({
        prepareId: "ppk_1",
        payoutId: "1",
        networkPassphrase: "Test SDF Network ; September 2015",
        signatureExpirationLedger: 4_500_000,
        authEntries: [fakeXdr],
      }).signatureExpirationLedger,
    ).toBe(4_500_000);
  });

  it("stubs the three passkey paths as auth none with CCR-20 schemas", () => {
    const passkey = A0_OPENAPI_STUBS.filter((s) =>
      s.path.includes("/passkey/"),
    );
    expect(passkey.map((s) => `${s.method} ${s.path}`).sort()).toEqual(
      [
        "post /v1/claims/{token}/passkey/deploy",
        "post /v1/claims/{token}/passkey/prepare",
        "post /v1/claims/{token}/passkey/submit",
      ].sort(),
    );
    for (const s of passkey) {
      expect(s.auth).toBe("none");
      expect(s.success.schema).toBeDefined();
    }
    expect(
      passkey.find((s) => s.path.endsWith("/deploy"))?.body,
    ).toBe(PasskeyDeployRequestSchema);
    expect(
      passkey.find((s) => s.path.endsWith("/prepare"))?.body,
    ).toBe(PasskeyPrepareRequestSchema);
    expect(
      passkey.find((s) => s.path.endsWith("/submit"))?.body,
    ).toBe(PasskeySubmitRequestSchema);
  });
});

describe("A0 OpenAPI stubs", () => {
  it("covers the DEV_PLAN A0 surfaces exactly once each", () => {
    const paths = A0_OPENAPI_STUBS.map((s) => `${s.method.toUpperCase()} ${s.path}`).sort();
    expect(paths).toEqual(
      [
        "GET /v1/batches/{id}",
        "GET /v1/claims/{token}",
        "GET /v1/endpoints",
        "GET /v1/events",
        "GET /v1/payments",
        "GET /v1/payments/{id}",
        "POST /v1/batches",
        "POST /v1/claims/{token}/accept",
        "POST /v1/claims/{token}/passkey/deploy",
        "POST /v1/claims/{token}/passkey/prepare",
        "POST /v1/claims/{token}/passkey/submit",
        "POST /v1/endpoints",
        "POST /v1/payments",
        "POST /v1/payments/{id}/cancel",
        "POST /v1/payments/{id}/fund",
        "POST /v1/quotes",
        "POST /v1/sandbox/advance-time",
        "POST /v1/sandbox/fail-next",
        "POST /v1/sandbox/provider-health",
        "POST /v1/sandbox/reset",
      ].sort(),
    );
  });
});
