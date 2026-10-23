import { describe, expect, it } from "vitest";
import {
  A0_OPENAPI_STUBS,
  ClaimAcceptRequestSchema,
  ClaimViewSchema,
  CreatePaymentRequestSchema,
  CreateQuoteRequestSchema,
  EVENT_TYPES,
  EventSchema,
  PaymentDetailSchema,
  PaymentSchema,
  QuoteSchema,
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
      simulated: true as const,
    },
    {
      kind: "convert" as const,
      rail: "sim_fx",
      providerId: "sim_fx",
      simulated: true as const,
    },
    {
      kind: "settle" as const,
      rail: "stellar_usdc",
      providerId: "stellar_usdc",
      simulated: true as const,
    },
    {
      kind: "convert" as const,
      rail: "sim_fx",
      providerId: "sim_fx",
      simulated: true as const,
    },
    {
      kind: "payout" as const,
      rail: "sim_bank_ph_instapay",
      providerId: "sim_bank_ph_instapay",
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
  },
  fxRate: "56.0000000",
  expectedReceive: moneyPhp("560000"),
  priceRiskBearer: "sender" as const,
  policy: "cheapest" as const,
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
});

describe("A0 QuoteSchema", () => {
  it("accepts a full quote response", () => {
    expect(QuoteSchema.parse(validQuote).id).toBe("quo_demo_1");
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
            externalRef: null,
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

  it("rejects fiat accept without country and unknown event types", () => {
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

describe("A0 sandbox schemas", () => {
  it("accepts fail-next shaped from ARCHITECTURE §10 and CCR-4", () => {
    expect(
      SandboxFailNextRequestSchema.parse({ providerId: "sim_bank_br_pix", count: 1 }).count,
    ).toBe(1);
  });

  it("lists advance-time as a path stub without a contracted body schema", () => {
    const advance = A0_OPENAPI_STUBS.find(
      (s) => s.path === "/v1/sandbox/advance-time" && s.method === "post",
    );
    expect(advance).toBeDefined();
    expect(advance?.body).toBeUndefined();
    expect(advance?.success.schema).toBeUndefined();
  });
});

describe("A0 OpenAPI stubs", () => {
  it("covers the DEV_PLAN A0 surfaces exactly once each", () => {
    const paths = A0_OPENAPI_STUBS.map((s) => `${s.method.toUpperCase()} ${s.path}`).sort();
    expect(paths).toEqual(
      [
        "GET /v1/claims/{token}",
        "GET /v1/events",
        "GET /v1/payments",
        "GET /v1/payments/{id}",
        "POST /v1/claims/{token}/accept",
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
