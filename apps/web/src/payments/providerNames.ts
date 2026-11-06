export type ProviderBadgeKind = "Simulated" | "Sandbox" | "Live"

/**
 * Known provider / rail ids → plain-English labels.
 * Unknown ids fall back to title-case with sim_ stripped.
 */
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
	blindpay_sandbox: "BlindPay",
	tazapay_sandbox: "Tazapay",
	sim_bank_br_pix: "Pix (simulated)",
	sim_fx: "FX (simulated)",
	solana_usdc: "Solana USDC",
	solana_tgbp: "Solana tGBP",
	stellar_usdc: "Stellar USDC",
}

/**
 * Today every partner path is Simulated or Sandbox — never present as Live.
 * A partner on its sandbox (CCR-29, e.g. blindpay_sandbox) reports simulated: true
 * because no real money moves, but it is a real partner API → Sandbox, not Simulated.
 * sim_* stays Simulated.
 */
export function providerBadge(
	simulated: boolean,
	providerId = "",
): ProviderBadgeKind {
	if (providerId.endsWith("_sandbox")) return "Sandbox"
	if (providerId.startsWith("sim_")) return "Simulated"
	return simulated ? "Simulated" : "Sandbox"
}

/** Short provider label from a rail / provider id. */
export function providerLabel(providerId: string): string {
	const known = PROVIDER_LABELS[providerId]
	if (known) return known
	const cleaned = providerId.replace(/^sim_/, "").replace(/_/g, " ").trim()
	if (!cleaned) return providerId
	return cleaned.replace(/\b\w/g, (ch) => ch.toUpperCase())
}
