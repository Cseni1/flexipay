import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SETTLEMENT_ERROR_CODES,
  SettlementError,
  addMoney,
  applyBps,
  compareMoney,
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

describe("settlement errors", () => {
  it("match the error table in contracts/payout_vault/RULES.md", () => {
    const rules = readFileSync(fileURLToPath(new URL("../../../contracts/payout_vault/RULES.md", import.meta.url)), "utf8");
    const rows = Object.fromEntries([...rules.matchAll(/^\| (\d+) \| (\w+)/gm)].map(([, c, n]) => [c, n]));
    expect(rows).toEqual({ ...SETTLEMENT_ERROR_CODES });
    const e = new SettlementError(12);
    expect([e.code, e.errorName]).toEqual([12, "DuplicateExternalId"]);
  });
});
