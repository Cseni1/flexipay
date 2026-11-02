import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@flexipay/domain";
import { createApp } from "../src/app.ts";
import { sandboxEnabledFromEnv } from "../src/sandbox-gate.ts";
import { auth as bearer, startTestServer, type TestServer } from "./helpers.ts";

// Sandbox controls are local-dev only: off unless FP_SANDBOX=1 (and never under
// NODE_ENV=production), and never authorised by a customer session.

const OPS = [
	["/v1/sandbox/fail-next", { providerId: "sim_fx" }],
	["/v1/sandbox/provider-health", { providerId: "sim_fx", health: "down" }],
	["/v1/sandbox/advance-time", { seconds: 5 }],
	["/v1/sandbox/reset", {}],
] as const;

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer({ auth: true });
}, 120_000);
afterAll(async () => {
	await s?.stop();
});

const post = (base: string, path: string, body: unknown, headers: Record<string, string>) =>
	fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

async function sessionCookie(email: string): Promise<string> {
	const h = { "content-type": "application/json", origin: s.origin, "x-forwarded-for": "10.9.9.9" };
	await post(s.base, "/api/auth/sign-up/email", { email, password: "correct-horse-1", name: "Sb" }, h);
	const link = /(https?:\/\/\S+)/.exec(s.mail.outbox.filter((m) => m.to === email).at(-1)!.text)![1]!;
	await fetch(link.replace(s.origin, s.base), { redirect: "manual" });
	const r = await post(s.base, "/api/auth/sign-in/email", { email, password: "correct-horse-1" }, h);
	return r.headers
		.getSetCookie()
		.map((c) => c.split(";")[0]!)
		.join("; ");
}

describe("sandbox gate: environment handling (unit)", () => {
	it("is off by default and for anything but the exact value 1", () => {
		expect(sandboxEnabledFromEnv({})).toBe(false);
		for (const v of ["0", "", "true", "yes", "on", "2", " 1"]) {
			expect(sandboxEnabledFromEnv({ FP_SANDBOX: v }), v).toBe(false);
		}
	});

	it("FP_SANDBOX=1 enables it for local development", () => {
		expect(sandboxEnabledFromEnv({ FP_SANDBOX: "1" })).toBe(true);
		expect(sandboxEnabledFromEnv({ FP_SANDBOX: "1", NODE_ENV: "development" })).toBe(true);
	});

	it("NODE_ENV=production overrides FP_SANDBOX=1", () => {
		expect(sandboxEnabledFromEnv({ FP_SANDBOX: "1", NODE_ENV: "production" })).toBe(false);
	});
});

describe("sandbox gate: enabled (local, explicit)", () => {
	it("an API key can use every sandbox operation", async () => {
		const { key } = await s.newOrg("sb-key");
		for (const [path, body] of OPS) {
			const r = await post(s.base, path, body, bearer(key));
			expect(r.status, path).toBe(200);
		}
	});

	it("a customer session can never use them, even when the sandbox is enabled", async () => {
		const cookie = await sessionCookie("sandbox-gate@example.com");
		expect((await fetch(`${s.base}/v1/me`, { headers: { cookie } })).status).toBe(200);
		for (const [path, body] of OPS) {
			const r = await post(s.base, path, body, {
				cookie,
				origin: s.origin,
				"content-type": "application/json",
			});
			expect(r.status, path).toBe(401);
		}
	});

	it("unauthenticated callers are refused", async () => {
		for (const [path, body] of OPS) {
			const r = await post(s.base, path, body, { "content-type": "application/json" });
			expect(r.status, path).toBe(401);
		}
	});
});

describe("sandbox gate: default (as on a hosted API)", () => {
	it("createApp without the flag answers 404 to everyone, keys included, and nothing runs", async () => {
		const loaded = await loadConfig(resolve(fileURLToPath(new URL("../../../config", import.meta.url))));
		if (!loaded.ok) throw new Error("config");
		const app = createApp({ db: s.db, config: loaded.config, runtime: s.runtime }).listen(0, "127.0.0.1");
		await new Promise((r) => app.once("listening", r));
		const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
		try {
			const { key } = await s.newOrg("sb-off");
			const before = s.runtime.clock.now().getTime();
			for (const [path, body] of OPS) {
				for (const headers of [bearer(key), { "content-type": "application/json" }]) {
					const r = await post(base, path, body, headers);
					expect(r.status, path).toBe(404);
				}
			}
			// advance-time really did not move the clock.
			expect(Math.abs(s.runtime.clock.now().getTime() - before)).toBeLessThan(2000);
			// Non-sandbox routes are unaffected.
			expect((await fetch(`${base}/v1/me`, { headers: bearer(key) })).status).toBe(200);
		} finally {
			await new Promise((r) => app.close(r));
		}
	});

	it("explicit false is also off", async () => {
		const loaded = await loadConfig(resolve(fileURLToPath(new URL("../../../config", import.meta.url))));
		if (!loaded.ok) throw new Error("config");
		const app = createApp({
			db: s.db,
			config: loaded.config,
			runtime: s.runtime,
			sandboxEnabled: false,
		}).listen(0, "127.0.0.1");
		await new Promise((r) => app.once("listening", r));
		const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
		try {
			const { key } = await s.newOrg("sb-off2");
			expect((await post(base, "/v1/sandbox/reset", {}, bearer(key))).status).toBe(404);
		} finally {
			await new Promise((r) => app.close(r));
		}
	});
});
