import { createHash, randomBytes } from "node:crypto";

// Off-chain mirrors of the vault's rules (contracts/payout_vault/RULES.md), so a quote
// can state exactly what the contract will lock and pay.

export type FeeMode = "PayerPays" | "RecipientPays";

const BPS = 10_000n;

/** The on-chain id of one lock attempt: sha256(utf8("<payment id>:<attempt>")), attempts from 1. */
export function externalIdFor(paymentId: string, attempt: number): Buffer {
  if (!paymentId) throw new Error("paymentId is required");
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`attempt must be an integer from 1, got ${attempt}`);
  }
  return createHash("sha256").update(`${paymentId}:${attempt}`, "utf8").digest();
}

/** A fresh claim-link secret and the hash the vault stores (sha256 of the secret bytes). */
export function newClaimSecret(): { secret: Buffer; claimHash: Buffer } {
  const secret = randomBytes(32);
  return { secret, claimHash: claimHashOf(secret) };
}

export function claimHashOf(secret: Buffer): Buffer {
  return createHash("sha256").update(secret).digest();
}

/** fee = amount * fee_bps / 10_000, rounded down; locked and net per FeeMode. */
export function payoutAmounts(
  amount: bigint,
  feeBps: number,
  mode: FeeMode,
): { fee: bigint; locked: bigint; net: bigint } {
  if (amount <= 0n) throw new Error("amount must be positive");
  const fee = (amount * BigInt(feeBps)) / BPS;
  return mode === "PayerPays"
    ? { fee, locked: amount + fee, net: amount }
    : { fee, locked: amount, net: amount - fee };
}
