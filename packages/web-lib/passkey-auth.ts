import { xdr } from "@stellar/stellar-sdk"

// Browser-safe XDR bridge for CCR-21 auth entries. The wire format is base64 Stellar XDR; the
// auth entries can carry the vault claim secret, so callers must keep them in memory only.
// Keeping the stellar-sdk import here means apps/web never imports the SDK directly.

export type SorobanAuthorizationEntry = xdr.SorobanAuthorizationEntry

export function decodeAuthEntryXdr(base64: string): SorobanAuthorizationEntry {
	return xdr.SorobanAuthorizationEntry.fromXDR(base64, "base64")
}

export function encodeAuthEntryXdr(entry: SorobanAuthorizationEntry): string {
	return entry.toXDR("base64")
}
