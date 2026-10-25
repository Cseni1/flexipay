import { describe, expect, it } from "vitest";
import {
	maskBearerToken,
	redactUrlQuery,
	sanitiseHostedUrl,
} from "../src/anchor-url.ts";

describe("evidence URL sanitisation", () => {
	it("strips query and hash from hosted URLs", () => {
		expect(
			sanitiseHostedUrl(
				"https://testanchor.stellar.org/sep24/interactive?token=sekrit#x",
			),
		).toBe("https://testanchor.stellar.org/sep24/interactive");
	});

	it("redacts sensitive query keys", () => {
		const out = redactUrlQuery(
			"https://example.test/x?asset=USDC&token=abc&keep=1",
		);
		expect(out).toContain("keep=1");
		expect(out).toContain("asset=USDC");
		expect(out).toContain("token=%5Bredacted%5D");
		expect(out).not.toContain("token=abc");
	});

	it("masks bearer tokens", () => {
		expect(maskBearerToken("aaaaaaaaaaaabbbbbbbbbbbb")).toMatch(/len=24/);
		expect(maskBearerToken("short")).toBe("[redacted-token]");
	});
});
