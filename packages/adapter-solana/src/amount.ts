/** FlexiPay domain USDC minor units use 7 decimals (Stellar test USDC / RULES.md). */
export const FLEXIPAY_USDC_DECIMALS = 7;

/**
 * Convert FlexiPay USDC minor units to the configured Solana mint decimals.
 * Rejects amounts that cannot be represented exactly on the mint.
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
			throw new Error(
				"payment amount is not representable at the Solana USDC mint decimals",
			);
		}
		return flexipayMinor / factor;
	}
	return (
		flexipayMinor * 10n ** BigInt(solanaDecimals - FLEXIPAY_USDC_DECIMALS)
	);
}
