import { createHash } from "node:crypto"

// The two digests the vault contract relies on (contracts/payout_vault/RULES.md): the claim hash
// the creator stores, and the per-attempt external id that is never reused.

/** Lower-case hex SHA-256 of the given bytes or UTF-8 string. */
export const sha256Hex = (data: Buffer | string): string =>
	createHash("sha256").update(data).digest("hex")

/**
 * RULES.md: the external id for one lock attempt is the 32-byte SHA-256 digest of the exact
 * UTF-8 string "<payment id>:<attempt>", attempts counting from 1, so a retry locks with a new
 * id and the vault never sees the same one twice. The client's own externalId never goes
 * on-chain and is not part of this derivation.
 */
export const lockExternalIdHex = (paymentId: string, attempt: number): string =>
	sha256Hex(Buffer.from(`${paymentId}:${attempt}`, "utf8"))
