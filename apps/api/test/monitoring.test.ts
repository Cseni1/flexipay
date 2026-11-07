import { describe, expect, it } from "vitest";
import { initMonitoring } from "../src/monitoring.ts";

describe("error monitoring (platform tracker 2.1)", () => {
	it("stays off without SENTRY_DSN", async () => {
		expect(await initMonitoring({})).toBe(false);
		expect(await initMonitoring({ SENTRY_DSN: "  " })).toBe(false);
	});
});
