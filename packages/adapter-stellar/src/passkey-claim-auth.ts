import { createHash } from "node:crypto";
import { Address, xdr } from "@stellar/stellar-sdk";

/** Default auth entry lifetime used when stamping prepare (ledgers). Matches passkey-kit deploy. */
export const PASSKEY_CLAIM_AUTH_LIFETIME_LEDGERS = 720;

export class PasskeyAuthMismatchError extends Error {
	readonly code = "auth_mismatch" as const;

	constructor(message: string) {
		super(message);
		this.name = "PasskeyAuthMismatchError";
	}
}

export function sha256HexBytes(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

export function parseAuthEntryXdr(base64: string): xdr.SorobanAuthorizationEntry {
	try {
		return xdr.SorobanAuthorizationEntry.fromXDR(base64, "base64");
	} catch {
		throw new PasskeyAuthMismatchError("signedAuthEntries contain invalid XDR");
	}
}

export function authEntryAddress(entry: xdr.SorobanAuthorizationEntry): string {
	const creds = entry.credentials();
	if (creds.switch().name !== "sorobanCredentialsAddress") {
		throw new PasskeyAuthMismatchError("auth entry must use address credentials");
	}
	return Address.fromScAddress(creds.address().address()).toString();
}

export function authEntryNonce(entry: xdr.SorobanAuthorizationEntry): string {
	const creds = entry.credentials();
	if (creds.switch().name !== "sorobanCredentialsAddress") {
		throw new PasskeyAuthMismatchError("auth entry must use address credentials");
	}
	return creds.address().nonce().toString();
}

export function authEntryExpirationLedger(
	entry: xdr.SorobanAuthorizationEntry,
): number {
	const creds = entry.credentials();
	if (creds.switch().name !== "sorobanCredentialsAddress") {
		throw new PasskeyAuthMismatchError("auth entry must use address credentials");
	}
	return creds.address().signatureExpirationLedger();
}

export function rootInvocationFingerprint(
	entry: xdr.SorobanAuthorizationEntry,
): string {
	return sha256HexBytes(Buffer.from(entry.rootInvocation().toXDR()));
}

/** Clone entry and set signatureExpirationLedger (unsigned entries for prepare). */
export function stampAuthEntryExpiration(
	entry: xdr.SorobanAuthorizationEntry,
	signatureExpirationLedger: number,
): xdr.SorobanAuthorizationEntry {
	const clone = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
	const creds = clone.credentials();
	if (creds.switch().name !== "sorobanCredentialsAddress") {
		throw new PasskeyAuthMismatchError("auth entry must use address credentials");
	}
	creds.address().signatureExpirationLedger(signatureExpirationLedger);
	return clone;
}

export interface PreparedAuthMeta {
	signatureExpirationLedger: number;
	/** sha256 hex of each unsigned rootInvocation XDR (order). */
	fingerprints: string[];
	/** Decimal nonce strings (order). */
	nonces: string[];
	/** Expected auth addresses, typically the passkey C… (order). */
	addresses: string[];
}

/**
 * Validate signed auth entries against prepare metadata (CCR-20).
 * Length/order, address, nonce, rootInvocation fingerprint, signatureExpirationLedger.
 */
export function matchSignedAuthEntries(
	meta: PreparedAuthMeta,
	signedAuthEntriesBase64: string[],
): xdr.SorobanAuthorizationEntry[] {
	if (signedAuthEntriesBase64.length !== meta.fingerprints.length) {
		throw new PasskeyAuthMismatchError(
			`expected ${meta.fingerprints.length} signedAuthEntries, got ${signedAuthEntriesBase64.length}`,
		);
	}
	const parsed: xdr.SorobanAuthorizationEntry[] = [];
	for (let i = 0; i < signedAuthEntriesBase64.length; i++) {
		const entry = parseAuthEntryXdr(signedAuthEntriesBase64[i]!);
		const address = authEntryAddress(entry);
		const nonce = authEntryNonce(entry);
		const exp = authEntryExpirationLedger(entry);
		const fp = rootInvocationFingerprint(entry);
		if (address !== meta.addresses[i]) {
			throw new PasskeyAuthMismatchError(
				`authAddresses[${i}] mismatch (expected ${meta.addresses[i]})`,
			);
		}
		if (nonce !== meta.nonces[i]) {
			throw new PasskeyAuthMismatchError(`authNonces[${i}] mismatch`);
		}
		if (fp !== meta.fingerprints[i]) {
			throw new PasskeyAuthMismatchError(
				`authInvocationFingerprints[${i}] mismatch`,
			);
		}
		if (exp !== meta.signatureExpirationLedger) {
			throw new PasskeyAuthMismatchError(
				`signatureExpirationLedger must be ${meta.signatureExpirationLedger}, got ${exp}`,
			);
		}
		parsed.push(entry);
	}
	return parsed;
}

/** Sealed prepare blob plaintext (never logged). */
export interface SealedPasskeyPrepareBlob {
	v: 1;
	authEntries: string[];
	hostFunction: string;
}

export function encodeSealedPrepareBlob(
	blob: SealedPasskeyPrepareBlob,
): Buffer {
	return Buffer.from(JSON.stringify(blob), "utf8");
}

export function decodeSealedPrepareBlob(plaintext: Buffer): SealedPasskeyPrepareBlob {
	let parsed: unknown;
	try {
		parsed = JSON.parse(plaintext.toString("utf8"));
	} catch {
		throw new Error("sealed prepare blob is not JSON");
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		(parsed as { v?: unknown }).v !== 1 ||
		!Array.isArray((parsed as { authEntries?: unknown }).authEntries) ||
		typeof (parsed as { hostFunction?: unknown }).hostFunction !== "string"
	) {
		throw new Error("sealed prepare blob shape invalid");
	}
	const authEntries = (parsed as SealedPasskeyPrepareBlob).authEntries;
	if (
		authEntries.length === 0 ||
		authEntries.some((e) => typeof e !== "string" || e.length === 0)
	) {
		throw new Error("sealed prepare authEntries invalid");
	}
	return {
		v: 1,
		authEntries,
		hostFunction: (parsed as SealedPasskeyPrepareBlob).hostFunction,
	};
}
