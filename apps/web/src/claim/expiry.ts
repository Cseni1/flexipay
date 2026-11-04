/** Day length in ms for "about N days left" (whole days, rounded). */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Claim-link expiry as a short date and 24h time, e.g. "10 Nov 2026, 16:59".
 * Locale-fixed so receivers see a consistent shape.
 */
export function formatClaimValidUntil(iso: string): string {
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return iso
	const day = new Intl.DateTimeFormat("en-GB", {
		day: "numeric",
		month: "short",
		year: "numeric",
	}).format(date)
	const time = new Intl.DateTimeFormat("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(date)
	return `${day}, ${time}`
}

/**
 * Rough remaining lifetime for claim links (API keeps them ≥ 7 days).
 * Returns null when already expired or the timestamp is invalid.
 */
export function aboutDaysLeft(
	iso: string,
	nowMs: number = Date.now(),
): string | null {
	const expiresAt = new Date(iso).getTime()
	if (Number.isNaN(expiresAt)) return null
	const remaining = expiresAt - nowMs
	if (remaining <= 0) return null
	const days = Math.max(1, Math.round(remaining / DAY_MS))
	return days === 1 ? "about 1 day left" : `about ${days} days left`
}

export function isClaimExpired(
	iso: string,
	nowMs: number = Date.now(),
): boolean {
	const expiresAt = new Date(iso).getTime()
	if (Number.isNaN(expiresAt)) return false
	return nowMs >= expiresAt
}

/** Copy for an expired claim link (API status or client clock). */
export const CLAIM_EXPIRED_ASK_SENDER =
	"This claim link has expired. Ask the sender for a new link."
