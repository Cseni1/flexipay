/** Token amount as a plain decimal string without trailing zeros (10000000 at 6 decimals -> "10"). */
export function tokenAmountDecimal(minor: bigint, decimals: number): string {
	if (decimals === 0) return minor.toString();
	const base = 10n ** BigInt(decimals);
	const whole = minor / base;
	const frac = (minor % base).toString().padStart(decimals, "0").replace(/0+$/, "");
	return frac ? `${whole}.${frac}` : whole.toString();
}

/** Pence as "£10.50" for the wallet message. */
export function poundsText(pence: bigint): string {
	const whole = pence / 100n;
	const frac = (pence % 100n).toString().padStart(2, "0");
	return `£${whole}.${frac}`;
}

/** Solana Pay transfer-request URL (https://docs.solanapay.com/spec#transfer-request). */
export function buildSolanaPayUrl(opts: {
	merchantWallet: string;
	amountMinor: bigint;
	decimals: number;
	mint: string;
	reference: string;
	label: string;
	message: string;
}): string {
	const q = [
		`amount=${tokenAmountDecimal(opts.amountMinor, opts.decimals)}`,
		`spl-token=${opts.mint}`,
		`reference=${opts.reference}`,
		`label=${encodeURIComponent(opts.label)}`,
		`message=${encodeURIComponent(opts.message)}`,
	].join("&");
	return `solana:${opts.merchantWallet}?${q}`;
}
