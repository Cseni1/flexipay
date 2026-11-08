/**
 * CCR-44: in live mode, FP_LIVE_PAYMENTS_ENABLED=0 stops new quotes and payments.
 * Reads, refunds and status polling are not affected.
 */
export function livePaymentsPaused(
	env: Record<string, string | undefined> = process.env,
): boolean {
	const cluster = (env.FP_SOLANA_CLUSTER ?? "").trim();
	if (cluster !== "mainnet-beta") return false;
	if (env.FP_LIVE_MONEY !== "1") return false;
	return env.FP_LIVE_PAYMENTS_ENABLED === "0";
}
