/**
 * Endpoint detail values are masked whenever they are returned (ARCHITECTURE §6.3, §14).
 * Keeps the last four characters so a user can recognise the account; everything else is `*`.
 * The mask rule itself is an implementation choice: CCR-16 only says "masked strings".
 */
export function maskDetail(value: string): string {
	if (value.length <= 4) return "*".repeat(Math.max(value.length, 4));
	return `${"*".repeat(Math.min(value.length - 4, 12))}${value.slice(-4)}`;
}

export function maskDetails(details: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (details && typeof details === "object") {
		for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
			out[key] = typeof value === "string" ? maskDetail(value) : "****";
		}
	}
	return out;
}
