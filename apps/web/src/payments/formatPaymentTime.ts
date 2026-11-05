/**
 * Local date+time for payment UI: "5 Nov 2026, 13:50:52".
 * Uses the viewer's local timezone; UTC belongs in the title attribute.
 */
export function formatLocalDateTime(iso: string): string {
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return "-"
	const day = date.getDate()
	const month = date.toLocaleString(undefined, { month: "short" })
	const year = date.getFullYear()
	const hh = String(date.getHours()).padStart(2, "0")
	const mm = String(date.getMinutes()).padStart(2, "0")
	const ss = String(date.getSeconds()).padStart(2, "0")
	return `${day} ${month} ${year}, ${hh}:${mm}:${ss}`
}

/** UTC clock for title tooltips, e.g. "5 Nov 2026, 13:50:52 UTC". */
export function formatUtcTitle(iso: string): string {
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return ""
	const day = date.getUTCDate()
	const month = date.toLocaleString("en-GB", {
		month: "short",
		timeZone: "UTC",
	})
	const year = date.getUTCFullYear()
	const hh = String(date.getUTCHours()).padStart(2, "0")
	const mm = String(date.getUTCMinutes()).padStart(2, "0")
	const ss = String(date.getUTCSeconds()).padStart(2, "0")
	return `${day} ${month} ${year}, ${hh}:${mm}:${ss} UTC`
}

/** Local wall-clock only (HH:MM:SS) for "Transfer sent at …". */
export function formatLocalClock(iso: string): string {
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return "--:--:--"
	const hh = String(date.getHours()).padStart(2, "0")
	const mm = String(date.getMinutes()).padStart(2, "0")
	const ss = String(date.getSeconds()).padStart(2, "0")
	return `${hh}:${mm}:${ss}`
}
