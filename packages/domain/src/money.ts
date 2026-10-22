import { z } from "zod";

// Money is an integer in minor units, sent as a string, with an explicit currency or asset
// code (ARCHITECTURE §6). No floats anywhere.

export const CurrencyCode = z.string().regex(/^[A-Z][A-Z0-9]{2,11}$/, "currency or asset code, e.g. USD, PHP, USDC");

export const MinorUnits = z.string().regex(/^(0|[1-9][0-9]*)$/, "non-negative integer minor units as a string");

export const MoneySchema = z.object({ amount: MinorUnits, currency: CurrencyCode }).strict();
export type Money = z.infer<typeof MoneySchema>;

export function money(amount: bigint | string, currency: string): Money {
  const value = typeof amount === "bigint" ? amount : BigInt(MinorUnits.parse(amount));
  if (value < 0n) throw new Error(`money cannot be negative: ${value}`);
  return { amount: value.toString(), currency };
}

export const toMinor = (m: Money): bigint => BigInt(m.amount);

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(toMinor(a) + toMinor(b), a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(toMinor(a) - toMinor(b), a.currency);
}

/** -1, 0 or 1. Throws on different currencies. */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  const d = toMinor(a) - toMinor(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

/** amount * bps / 10_000, rounded down (the vault's rule). */
export function applyBps(m: Money, bps: number): Money {
  if (!Number.isInteger(bps) || bps < 0) throw new Error(`bps must be a non-negative integer, got ${bps}`);
  return money((toMinor(m) * BigInt(bps)) / 10_000n, m.currency);
}
