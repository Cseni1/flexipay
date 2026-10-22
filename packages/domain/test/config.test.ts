import { describe, expect, it } from "vitest";
import { validateConfig, type RawConfig } from "../src/index.ts";

// Minimal neutral fixture, not the real config: US domestic, one crypto corridor, one bank-only.
const usd = (amount: string) => ({ amount, currency: "USD" });

function provider(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "bank",
    countries: ["US"],
    currencies: ["USD"],
    endpointTypes: ["bank_account"],
    legKinds: ["collect", "payout"],
    fee: { fixed: usd("0"), bps: 0 },
    fxSpreadBps: 0,
    estimatedTimeSeconds: 60,
    limits: { min: usd("100"), max: usd("5000000") },
    simulated: true,
    placeholder: true,
    ...over,
  };
}

const limits = { individual: { min: usd("100"), max: usd("500000") }, company: { min: usd("100"), max: usd("5000000") } };

function corridor(over: Record<string, unknown> = {}) {
  return {
    from: { country: "US", currency: "USD" },
    to: { country: "US", currency: "USD" },
    allowedDestinationTypes: ["bank_account"],
    recipientKinds: ["individual", "company"],
    cryptoLegAllowed: { individual: false, company: false },
    limits,
    legsAvailable: { collect: ["sim_bank_us"], convert: [], settle: [], payout: ["sim_bank_us"] },
    domesticRail: "sim_bank_us",
    regulationNote: "Domestic, bank account only.",
    simulated: true,
    placeholder: true,
    ...over,
  };
}

const crypto = corridor({
  to: { country: "PH", currency: "PHP" },
  allowedDestinationTypes: ["bank_account", "crypto_wallet"],
  cryptoLegAllowed: { individual: true, company: true },
  legsAvailable: { collect: ["sim_bank_us"], convert: ["sim_fx"], settle: ["test_rail"], payout: ["sim_bank_ph"] },
  domesticRail: null,
  regulationNote: "Cross-border, simulated rails.",
});

const bankOnly = corridor({
  to: { country: "ZA", currency: "ZAR" },
  legsAvailable: { collect: ["sim_bank_us"], convert: ["sim_fx"], settle: [], payout: ["sim_bank_za"] },
  domesticRail: null,
  regulationNote: "Bank rails only; demo policy.",
});

function valid(): RawConfig {
  return {
    corridors: { corridors: [corridor(), crypto, bankOnly] },
    providers: {
      providers: [
        provider("sim_bank_us"),
        provider("sim_bank_ph", { countries: ["PH"], currencies: ["PHP"], legKinds: ["payout"], fee: { fixed: { amount: "1500", currency: "PHP" }, bps: 50 }, limits: null }),
        provider("sim_bank_za", { countries: ["ZA"], currencies: ["ZAR"], legKinds: ["payout"], fee: { fixed: { amount: "500", currency: "ZAR" }, bps: 80 }, limits: null }),
        provider("sim_fx", { kind: "fx", countries: ["US", "PH", "ZA"], currencies: ["USD", "PHP", "ZAR"], endpointTypes: [], legKinds: ["convert"], limits: null }),
      ],
      settlementRails: [{ id: "test_rail", network: "stellar", asset: "USDC", simulated: false }],
      fxRates: [
        { from: "USD", to: "USDC", rate: "1.0000000", placeholder: true },
        { from: "USDC", to: "PHP", rate: "56.0000000", placeholder: true },
        { from: "USD", to: "ZAR", rate: "18.0000000", placeholder: true },
      ],
    },
    fees: { quoteValiditySeconds: 120, priceRiskBearer: "sender", tipsFeeBps: 0, placeholder: true },
  };
}

function messages(raw: RawConfig): string[] {
  const r = validateConfig(raw);
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`);
}

function withCorridor(index: number, over: Record<string, unknown>): RawConfig {
  const raw = valid();
  const list = (raw.corridors as { corridors: Record<string, unknown>[] }).corridors;
  list[index] = { ...list[index], ...over };
  return raw;
}

describe("validateConfig", () => {
  it("accepts a valid config", () => {
    const r = validateConfig(valid());
    expect(r.ok ? [] : r.issues).toEqual([]);
  });

  it("rejects unknown fields, floats and missing simulation flags", () => {
    expect(messages(withCorridor(0, { cheapestRoute: true })).join()).toMatch(/Unrecognized key/);
    expect(messages(withCorridor(0, { limits: { ...limits, individual: { min: { amount: "1.5", currency: "USD" }, max: usd("9") } } })).join()).toMatch(/integer minor units/);
    const raw = valid();
    delete (raw.corridors as { corridors: Record<string, unknown>[] }).corridors[0].simulated;
    expect(messages(raw).join()).toMatch(/simulated/);
  });

  it("rejects a settle rail or crypto destination where no recipient kind may use crypto (South Africa rule)", () => {
    expect(messages(withCorridor(2, { legsAvailable: { collect: ["sim_bank_us"], convert: ["sim_fx"], settle: ["test_rail"], payout: ["sim_bank_za"] } })).join())
      .toMatch(/US-ZA: crypto leg not allowed for any recipient kind/);
    expect(messages(withCorridor(2, { allowedDestinationTypes: ["bank_account", "crypto_wallet"] })).join())
      .toMatch(/US-ZA: crypto destinations \(crypto_wallet\) need a crypto leg/);
  });

  it("requires a settle rail for crypto destinations", () => {
    expect(messages(withCorridor(1, { legsAvailable: { collect: ["sim_bank_us"], convert: ["sim_fx"], settle: [], payout: ["sim_bank_ph"] } })).join())
      .toMatch(/crypto destinations need a settle rail/);
  });

  it("checks provider references and leg kinds", () => {
    expect(messages(withCorridor(1, { legsAvailable: { collect: ["sim_bank_us"], convert: ["sim_fx"], settle: ["test_rail"], payout: ["nope"] } })).join())
      .toMatch(/unknown provider nope/);
    expect(messages(withCorridor(1, { legsAvailable: { collect: ["sim_bank_us"], convert: ["sim_fx"], settle: ["sim_fx"], payout: ["sim_bank_ph"] } })).join())
      .toMatch(/unknown settlement rail sim_fx/);
    expect(messages(withCorridor(1, { legsAvailable: { collect: ["sim_fx"], convert: ["sim_fx"], settle: ["test_rail"], payout: ["sim_bank_ph"] } })).join())
      .toMatch(/sim_fx does not serve collect/);
  });

  it("ties domesticRail to same-country corridors", () => {
    expect(messages(withCorridor(0, { domesticRail: null })).join()).toMatch(/needs a domesticRail/);
    expect(messages(withCorridor(1, { domesticRail: "sim_bank_us" })).join()).toMatch(/only for same-country/);
  });

  it("needs a payout provider for each fiat destination type in the destination country", () => {
    expect(messages(withCorridor(1, { allowedDestinationTypes: ["bank_account", "ewallet", "crypto_wallet"] })).join())
      .toMatch(/no payout provider for ewallet in PH/);
  });

  it("keeps limits send-side in the from currency with min <= max", () => {
    const php = { min: { amount: "100", currency: "PHP" }, max: { amount: "900", currency: "PHP" } };
    expect(messages(withCorridor(1, { limits: { ...limits, company: php } })).join()).toMatch(/send-side, in USD/);
    expect(messages(withCorridor(1, { limits: { ...limits, company: { min: usd("9"), max: usd("1") } } })).join()).toMatch(/min is greater than max/);
  });

  it("rejects duplicate corridors and provider ids", () => {
    const raw = valid();
    (raw.corridors as { corridors: unknown[] }).corridors.push(corridor());
    (raw.providers as { providers: unknown[] }).providers.push(provider("sim_bank_us"));
    const all = messages(raw).join();
    expect(all).toMatch(/duplicate corridor/);
    expect(all).toMatch(/duplicate id sim_bank_us/);
  });

  it("needs an fx rate for every conversion a route can use", () => {
    const raw = valid();
    (raw.providers as { fxRates: unknown[] }).fxRates.pop();
    expect(messages(raw).join()).toMatch(/US-ZA: missing fx rate USD > ZAR/);
    const raw2 = valid();
    (raw2.providers as { fxRates: unknown[] }).fxRates.splice(1, 1);
    expect(messages(raw2).join()).toMatch(/US-PH: missing fx rate USDC > PHP/);
  });

  it("rejects duplicate, zero and unknown-currency rates", () => {
    const raw = valid();
    const rates = (raw.providers as { fxRates: Record<string, unknown>[] }).fxRates;
    rates.push({ ...rates[0] }, { from: "USD", to: "XYZ", rate: "0", placeholder: true });
    const all = messages(raw).join();
    expect(all).toMatch(/duplicate rate USD>USDC/);
    expect(all).toMatch(/rate must be above zero/);
    expect(all).toMatch(/no minor-unit decimals known for XYZ/);
  });

  it("keeps the vault fee out of fees.json", () => {
    const raw = valid();
    (raw.fees as Record<string, unknown>).vaultFeeBps = 100;
    expect(messages(raw).join()).toMatch(/Unrecognized key/);
  });
});
