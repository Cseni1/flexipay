import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * CCR-11: AES-256-GCM seal for vault claim secrets.
 * Key: `FP_CLAIM_SEAL_KEY` — 32 bytes as 64 hex chars (never logged or committed).
 */

const ALGO = "aes-256-gcm";
const NONCE_LEN = 12;

export function claimSealKeyFromEnv(
	env: Record<string, string | undefined> = process.env,
): Buffer {
	const hex = env.FP_CLAIM_SEAL_KEY?.trim();
	if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
		throw new Error(
			"FP_CLAIM_SEAL_KEY must be 64 hex chars (32-byte AES key) for claim seal (CCR-11)",
		);
	}
	return Buffer.from(hex, "hex");
}

export function sealClaimSecret(
	secretHex: string,
	key: Buffer,
): { sealed: Buffer; nonce: Buffer } {
	const nonce = randomBytes(NONCE_LEN);
	const cipher = createCipheriv(ALGO, key, nonce);
	const plaintext = Buffer.from(secretHex, "utf8");
	const sealed = Buffer.concat([
		cipher.update(plaintext),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	return { sealed, nonce };
}

export function unsealClaimSecret(
	sealed: Buffer,
	nonce: Buffer,
	key: Buffer,
): string {
	if (sealed.length < 16) {
		throw new Error("claim secretSealed too short");
	}
	const authTag = sealed.subarray(sealed.length - 16);
	const ciphertext = sealed.subarray(0, sealed.length - 16);
	const decipher = createDecipheriv(ALGO, key, nonce);
	decipher.setAuthTag(authTag);
	return Buffer.concat([
		decipher.update(ciphertext),
		decipher.final(),
	]).toString("utf8");
}

/** AES-256-GCM for arbitrary recovery bytes (passkey deploy / release envelopes). */
export function sealBytes(
	plaintext: Buffer,
	key: Buffer,
): { sealed: Uint8Array<ArrayBuffer>; nonce: Uint8Array<ArrayBuffer> } {
	const nonce = randomBytes(NONCE_LEN);
	const cipher = createCipheriv(ALGO, key, nonce);
	const sealed = Buffer.concat([
		cipher.update(plaintext),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	// Prisma `Bytes` columns accept ArrayBuffer-backed arrays only, not Buffer<ArrayBufferLike>.
	return { sealed: new Uint8Array(sealed), nonce: new Uint8Array(nonce) };
}

export function unsealBytes(
	sealed: Buffer,
	nonce: Buffer,
	key: Buffer,
): Buffer {
	if (sealed.length < 16) {
		throw new Error("sealed payload too short");
	}
	const authTag = sealed.subarray(sealed.length - 16);
	const ciphertext = sealed.subarray(0, sealed.length - 16);
	const decipher = createDecipheriv(ALGO, key, nonce);
	decipher.setAuthTag(authTag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
