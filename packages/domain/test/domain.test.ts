import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SETTLEMENT_ERROR_CODES,
  SettlementError,
  addMoney,
  applyBps,
  compareMoney,
  convertMoney,
  money,
  subtractMoney,
} from "../src/index.ts";

describe("money", () => {
  it("keeps integer minor units as strings", () => {
    expect(money(150n, "USD")).toEqual({ amount: "150", currency: "USD" });
    expect(addMoney(money("100", "USD"), money("50", "USD")).amount).toBe("150");
    expect(subtractMoney(money("100", "USD"), money("40", "USD")).amount).toBe("60");
  });

  it("refuses floats, negatives and mixed currencies", () => {
    expect(() => money("1.5", "USD")).toThrow();
    expect(() => subtractMoney(money("1", "USD"), money("2", "USD"))).toThrow(/negative/);
    expect(() => compareMoney(money("1", "USD"), money("1", "PHP"))).toThrow(/currency mismatch/);
  });

  it("applies basis points rounding down, like the vault", () => {
    expect(applyBps(money("1000000000", "USDC"), 150).amount).toBe("15000000");
    expect(applyBps(money("199", "USD"), 100).amount).toBe("1");
  });
});

describe("convertMoney (CCR-4)", () => {
  it("converts between currencies with different minor-unit decimals", () => {
    expect(convertMoney(money("10000", "USD"), "1.0000000", "USDC")).toEqual({ amount: "1000000000", currency: "USDC" });
    expect(convertMoney(money("10000", "USD"), "56.0000000", "PHP")).toEqual({ amount: "560000", currency: "PHP" });
    expect(convertMoney(money("1000000000", "USDC"), "5.5000000", "BRL")).toEqual({ amount: "55000", currency: "BRL" });
  });

  it("rounds down and handles fractional rates", () => {
    expect(convertMoney(money("1", "USD"), "5.5555555", "BRL").amount).toBe("5");
    expect(convertMoney(money("3", "USD"), "0.3333333", "ZAR").amount).toBe("0");
  });

  it("refuses unknown currencies and malformed rates", () => {
    expect(() => convertMoney(money("1", "USD"), "1", "XYZ")).toThrow(/decimals/);
    expect(() => convertMoney(money("1", "USD"), "1.12345678", "PHP")).toThrow();
    expect(() => convertMoney(money("1", "USD"), "-1", "PHP")).toThrow();
  });
});

describe("settlement errors", () => {
  it("match the error table in contracts/payout_vault/RULES.md", () => {
    const rules = readFileSync(fileURLToPath(new URL("../../../contracts/payout_vault/RULES.md", import.meta.url)), "utf8");
    const rows = Object.fromEntries([...rules.matchAll(/^\| (\d+) \| (\w+)/gm)].map(([, c, n]) => [c, n]));
    expect(rows).toEqual({ ...SETTLEMENT_ERROR_CODES });
    const e = new SettlementError(12);
    expect([e.code, e.errorName]).toEqual([12, "DuplicateExternalId"]);
  });
});
