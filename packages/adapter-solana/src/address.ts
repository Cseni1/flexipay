import { PublicKey } from "@solana/web3.js";

export function isSolanaAddress(value: string): boolean {
	try {
		const key = new PublicKey(value);
		return PublicKey.isOnCurve(key.toBytes());
	} catch {
		return false;
	}
}

export function parseSolanaAddress(value: string): PublicKey {
	if (!isSolanaAddress(value)) {
		throw new Error(`invalid Solana address: ${value.slice(0, 12)}…`);
	}
	return new PublicKey(value);
}
