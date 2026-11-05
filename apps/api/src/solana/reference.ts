import { Connection, PublicKey } from "@solana/web3.js";
import { getSolanaRuntimeConfig } from "./runtime-config.ts";

/** Signatures of confirmed, non-failed transactions that include `reference`, newest first. */
export type ReferenceLookupFn = (
	reference: string,
	limit: number,
) => Promise<string[]>;

const lookupViaRpc: ReferenceLookupFn = async (reference, limit) => {
	const cfg = getSolanaRuntimeConfig();
	const connection = new Connection(cfg.rpcUrl, "confirmed");
	const rows = await connection.getSignaturesForAddress(
		new PublicKey(reference),
		{ limit },
		"confirmed",
	);
	return rows.filter((r) => r.err === null).map((r) => r.signature);
};

let lookupImpl: ReferenceLookupFn = lookupViaRpc;

/** Test-only hook. Production code must not call this. */
export function setReferenceLookupForTests(fn: ReferenceLookupFn | null): void {
	lookupImpl = fn ?? lookupViaRpc;
}

export function findReferenceSignatures(
	reference: string,
	limit = 5,
): Promise<string[]> {
	return lookupImpl(reference, limit);
}

// Per-request throttle: at most one on-chain look-up per window (the till screen polls every ~2s).
let throttleMs = 2000;
const lastLookupAt = new Map<string, number>();

/** Test-only hook: 0 disables the throttle. */
export function setReferenceThrottleMsForTests(ms: number | null): void {
	throttleMs = ms ?? 2000;
	lastLookupAt.clear();
}

/** True when a look-up for this request may run now (and records it); false when throttled. */
export function takeReferenceLookupSlot(requestId: string): boolean {
	const now = Date.now();
	const last = lastLookupAt.get(requestId);
	if (last !== undefined && now - last < throttleMs) return false;
	lastLookupAt.set(requestId, now);
	return true;
}

export function releaseReferenceLookupSlot(requestId: string): void {
	lastLookupAt.delete(requestId);
}
