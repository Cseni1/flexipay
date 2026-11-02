/** FlexiPay domain USDC minor units use 7 decimals (Stellar test USDC / RULES.md). */
export const FLEXIPAY_USDC_DECIMALS = 7;

/** Stable API / domain code when a FlexiPay USDC amount cannot map onto the mint. */
export const AMOUNT_NOT_REPRESENTABLE_CODE = "amount_not_representable";

export class AmountNotRepresentableError extends Error {
	readonly code = AMOUNT_NOT_REPRESENTABLE_CODE;

	constructor(
		message = "payment amount is not representable at the Solana USDC mint decimals",
	) {
		super(message);
		this.name = "AmountNotRepresentableError";
	}
}

/**
 * Convert FlexiPay USDC minor units to the configured Solana mint decimals.
 * Rejects amounts that cannot be represented exactly on the mint.
 * Callers that surface this to HTTP should map {@link AmountNotRepresentableError}
 * to 422 (not 500). Quote-time floor for `solana_usdc` should prevent this for
 * normal quotes; the throw remains a safety net.
 */
export function flexipayUsdcToSolanaMinor(
	flexipayMinor: bigint,
	solanaDecimals: number,
): bigint {
	if (solanaDecimals === FLEXIPAY_USDC_DECIMALS) return flexipayMinor;
	if (solanaDecimals < 0 || solanaDecimals > 9) {
		throw new Error("invalid Solana USDC decimals");
	}
	if (solanaDecimals < FLEXIPAY_USDC_DECIMALS) {
		const factor = 10n ** BigInt(FLEXIPAY_USDC_DECIMALS - solanaDecimals);
		if (flexipayMinor % factor !== 0n) {
			throw new AmountNotRepresentableError();
		}
		return flexipayMinor / factor;
	}
	return (
		flexipayMinor * 10n ** BigInt(solanaDecimals - FLEXIPAY_USDC_DECIMALS)
	);
}
