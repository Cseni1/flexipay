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

// ---- conversion (CCR-4) ----

/** Minor-unit exponents. Test USDC has 7 decimals like USDC on Stellar (RULES.md). */
export const CURRENCY_DECIMALS: Readonly<Record<string, number>> = {
  USD: 2,
  PHP: 2,
  BRL: 2,
  ZAR: 2,
  USDC: 7,
};

/**
 * Circle Solana USDC mint decimals (devnet + mainnet). FlexiPay domain USDC is 7;
 * on-chain Solana transfers need amounts representable at 6 decimals.
 */
export const SOLANA_USDC_MINT_DECIMALS = 6;

/**
 * Floor FlexiPay USDC minor units (7 decimals) down to a multiple of
 * `10^(7-6)=10` so the amount is exactly representable on the Solana USDC mint.
 * Examples: 9851485 → 9851480; 9950000 → 9950000.
 * Used at quote time for `solana_usdc` and for crypto_wallet USDC settles
 * (which may pay on Solana after claim accept). Not applied to fiat bank settles.
 */
export function floorUsdcMinorForSolanaMint(flexipayMinor: bigint): bigint {
  const domain = CURRENCY_DECIMALS.USDC;
  if (domain === undefined) throw new Error("USDC decimals missing");
  if (SOLANA_USDC_MINT_DECIMALS > domain) {
    throw new Error("Solana USDC mint decimals exceed FlexiPay USDC decimals");
  }
  const step = 10n ** BigInt(domain - SOLANA_USDC_MINT_DECIMALS);
  return flexipayMinor - (flexipayMinor % step);
}

const RATE_SCALE = 7;

export const RateString = z.string().regex(/^[0-9]+(\.[0-9]{1,7})?$/, "decimal rate with up to 7 decimals");

function decimalsOf(currency: string): number {
  const d = CURRENCY_DECIMALS[currency];
  if (d === undefined) throw new Error(`unknown currency decimals for ${currency}`);
  return d;
}

function scaledRate(rate: string): bigint {
  RateString.parse(rate);
  const [whole, frac = ""] = rate.split(".");
  return BigInt(whole + frac.padEnd(RATE_SCALE, "0"));
}

/**
 * Converts at `rate` (major units of `from` to major units of `to`), rounding down. Integer
 * arithmetic only: out = in * rate * 10^toDecimals / (10^7 * 10^fromDecimals).
 */
export function convertMoney(m: Money, rate: string, toCurrency: string): Money {
  const num = toMinor(m) * scaledRate(rate) * 10n ** BigInt(decimalsOf(toCurrency));
  const den = 10n ** BigInt(RATE_SCALE) * 10n ** BigInt(decimalsOf(m.currency));
  return money(num / den, toCurrency);
}
