import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  VAULT_ERRORS,
  claimHashOf,
  externalIdFor,
  loadStellarEnv,
  newClaimSecret,
  parseEnvFile,
  payoutAmounts,
  toVaultError,
} from "../src/index.ts";

const repoFile = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");

const UNIT = 10_000_000n; // 7 decimals, like USDC on Stellar

describe("externalIdFor", () => {
  it("is sha256 of '<payment id>:<attempt>'", () => {
    expect(externalIdFor("pay_demo_1", 1).toString("hex")).toBe(
      "0c21059804ded6a04ed3f96fa1c24c7c4312c194aa59e0f3c9d9ac5476c2a7ca",
    );
    expect(externalIdFor("pay_demo_1", 2).toString("hex")).toBe(
      "a6787b0ff947203983c972236921ced5e02692155e806ac6b1da9bfbe4562f6d",
    );
  });

  it("rejects attempts below 1 and an empty payment id", () => {
    expect(() => externalIdFor("pay_demo_1", 0)).toThrow();
    expect(() => externalIdFor("pay_demo_1", 1.5)).toThrow();
    expect(() => externalIdFor("", 1)).toThrow();
  });
});

describe("claim secrets", () => {
  it("stores sha256 of the secret bytes", () => {
    const { secret, claimHash } = newClaimSecret();
    expect(secret).toHaveLength(32);
    expect(claimHash.equals(claimHashOf(secret))).toBe(true);
    expect(newClaimSecret().secret.equals(secret)).toBe(false);
  });
});

describe("payoutAmounts (same numbers as the contract tests)", () => {
  it("PayerPays locks amount + fee, recipient gets the amount", () => {
    expect(payoutAmounts(100n * UNIT, 150, "PayerPays")).toEqual({
      fee: 1_5000000n,
      locked: 101_5000000n,
      net: 100n * UNIT,
    });
  });

  it("RecipientPays locks the amount, recipient gets amount - fee", () => {
    expect(payoutAmounts(100n * UNIT, 150, "RecipientPays")).toEqual({
      fee: 1_5000000n,
      locked: 100n * UNIT,
      net: 98_5000000n,
    });
  });

  it("rounds the fee down", () => {
    expect(payoutAmounts(199n, 100, "PayerPays").fee).toBe(1n);
    expect(payoutAmounts(99n, 100, "PayerPays").fee).toBe(0n);
  });

  it("rejects a non-positive amount", () => {
    expect(() => payoutAmounts(0n, 100, "PayerPays")).toThrow();
  });
});

describe("vault errors", () => {
  it("match the error table in contracts/payout_vault/RULES.md", () => {
    const rows = [...repoFile("contracts/payout_vault/RULES.md").matchAll(/^\| (\d+) \| (\w+)/gm)];
    const fromRules = Object.fromEntries(rows.map(([, code, name]) => [code, name]));
    expect(fromRules).toEqual(
      Object.fromEntries(Object.entries(VAULT_ERRORS).map(([c, n]) => [c, n])),
    );
  });

  it("are read from host error text and from decoded names", () => {
    const fromHost = toVaultError(new Error("HostError: Error(Contract, #12)\n\nEvent log ..."));
    expect(fromHost?.code).toBe(12);
    expect(fromHost?.errorName).toBe("DuplicateExternalId");
    expect(toVaultError({ message: "BadSecret" })?.code).toBe(10);
  });

  it("are not invented for unknown codes or other failures", () => {
    expect(toVaultError("Error(Contract, #99)")).toBeUndefined();
    expect(toVaultError(new Error("network down"))).toBeUndefined();
    expect(toVaultError({ message: "" })).toBeUndefined();
  });
});

describe("stellar env", () => {
  const ids = parseEnvFile(repoFile("scripts/testnet/testnet-ids.env"));

  it("loads the published testnet ids", () => {
    const env = loadStellarEnv(ids);
    expect(env.payoutVaultId).toMatch(/^C[A-Z0-9]{55}$/);
    expect(env.networkPassphrase).toBe("Test SDF Network ; September 2015");
    expect(env.vaultFeeBps).toBe(100);
  });

  it("names every missing setting", () => {
    expect(() => loadStellarEnv({})).toThrow(/FP_PAYOUT_VAULT_ID/);
  });

  it("rejects an impossible vault fee", () => {
    expect(() => loadStellarEnv({ ...ids, FP_VAULT_FEE_BPS: "1001" })).toThrow();
  });
});
