import { PublicKey } from "@solana/web3.js";

/**
 * True for any well-formed 32-byte Solana public key.
 *
 * Off-curve keys are accepted on purpose: smart wallets (for example the Crossmint embedded
 * FlexiPay wallet) are program-derived addresses that sit off the ed25519 curve but can hold
 * and receive SPL tokens. The old on-curve rule gave no real protection (a mistyped address is
 * as likely to be on the curve as off it), and it blocked paying to or from smart wallets.
 */
export function isSolanaAddress(value: string): boolean {
	try {
		return new PublicKey(value).toBytes().length === 32;
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
