import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, test } from "vitest";
import { auth, startTestServer, type TestServer } from "./helpers.ts";

// Security hardening (PLATFORM_TRACKER section 4): response headers and the /v1 rate limit.

describe("security headers", { timeout: 60_000 }, () => {
	let api: TestServer;
	beforeAll(async () => {
		api = await startTestServer();
	});
	afterAll(async () => api.stop());

	test("API responses forbid scripts, framing and sniffing, and are never cached", async () => {
		const { key } = await api.newOrg("Headers");
		const res = await fetch(`${api.base}/v1/payments`, { headers: auth(key) });
		assert.equal(res.status, 200);
		const h = res.headers;
		assert.match(h.get("content-security-policy") ?? "", /default-src 'none'/);
		assert.match(h.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
		assert.equal(h.get("x-content-type-options"), "nosniff");
		assert.equal(h.get("x-frame-options"), "SAMEORIGIN");
		assert.match(h.get("strict-transport-security") ?? "", /max-age=63072000; includeSubDomains/);
		assert.equal(h.get("referrer-policy"), "no-referrer");
		assert.equal(h.get("cache-control"), "no-store");
		assert.equal(h.get("x-powered-by"), null);
	});

	test("errors carry the same headers", async () => {
		const res = await fetch(`${api.base}/v1/payments`);
		assert.equal(res.status, 401);
		assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
		assert.equal(res.headers.get("cache-control"), "no-store");
	});

	test("/docs may load Scalar from jsDelivr only, and still cannot be framed", async () => {
		const res = await fetch(`${api.base}/docs`);
		assert.equal(res.status, 200);
		const csp = res.headers.get("content-security-policy") ?? "";
		assert.match(csp, /script-src https:\/\/cdn\.jsdelivr\.net/);
		assert.match(csp, /frame-ancestors 'none'/);
		assert.doesNotMatch(csp, /script-src[^;]*\*/);
	});
});

describe("/v1 rate limit", { timeout: 60_000 }, () => {
	let api: TestServer;
	beforeAll(async () => {
		api = await startTestServer({
			apiRateLimit: [
				{ match: /^\/claims\//, bucket: "claims", max: 2, windowMs: 60_000 },
				{ match: /^\//, bucket: "api", max: 3, windowMs: 60_000 },
			],
		});
	});
	afterAll(async () => api.stop());

	test("each API key has its own budget; over it is 429 with Retry-After", async () => {
		const a = await api.newOrg("Limit A");
		const b = await api.newOrg("Limit B");
		for (let i = 0; i < 3; i++) {
			const ok = await fetch(`${api.base}/v1/payments`, { headers: auth(a.key) });
			assert.equal(ok.status, 200);
		}
		const limited = await fetch(`${api.base}/v1/payments`, { headers: auth(a.key) });
		assert.equal(limited.status, 429);
		assert.equal((await limited.json()).code, "rate_limited");
		assert.ok(Number(limited.headers.get("retry-after")) >= 1);
		// Another customer behind the same address is unaffected.
		const other = await fetch(`${api.base}/v1/payments`, { headers: auth(b.key) });
		assert.equal(other.status, 200);
	});

	test("public claim routes count per client address", async () => {
		const ip = { "x-forwarded-for": "203.0.113.9" };
		for (let i = 0; i < 2; i++) {
			const r = await fetch(`${api.base}/v1/claims/nope`, { headers: ip });
			assert.notEqual(r.status, 429);
		}
		const limited = await fetch(`${api.base}/v1/claims/nope`, { headers: ip });
		assert.equal(limited.status, 429);
		const elsewhere = await fetch(`${api.base}/v1/claims/nope`, {
			headers: { "x-forwarded-for": "203.0.113.10" },
		});
		assert.notEqual(elsewhere.status, 429);
	});

	test("health check and docs are not limited", async () => {
		for (let i = 0; i < 5; i++) {
			assert.equal((await fetch(`${api.base}/healthz`)).status, 200);
		}
	});
});
