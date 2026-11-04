import { describe, expect, it } from "vitest"
import {
	aboutDaysLeft,
	formatClaimValidUntil,
	isClaimExpired,
} from "../src/claim/expiry"

describe("claim expiry helpers", () => {
	it("formats valid-until as day month year, 24h time", () => {
		// Fixed UTC instant so the en-GB shape is stable in CI.
		const formatted = formatClaimValidUntil("2026-11-10T16:59:00.000Z")
		expect(formatted).toMatch(/^\d{1,2} Nov 2026, \d{2}:\d{2}$/)
	})

	it("reports about N days left from now", () => {
		const now = Date.parse("2026-11-03T12:00:00.000Z")
		expect(aboutDaysLeft("2026-11-10T12:00:00.000Z", now)).toBe(
			"about 7 days left",
		)
		expect(aboutDaysLeft("2026-11-04T12:00:00.000Z", now)).toBe(
			"about 1 day left",
		)
		expect(aboutDaysLeft("2026-11-02T12:00:00.000Z", now)).toBeNull()
	})

	it("detects expiry", () => {
		const now = Date.parse("2026-11-10T17:00:00.000Z")
		expect(isClaimExpired("2026-11-10T16:59:00.000Z", now)).toBe(true)
		expect(isClaimExpired("2026-11-10T17:01:00.000Z", now)).toBe(false)
	})
})
