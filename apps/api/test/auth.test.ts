import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@flexipay/domain";
import { createApp } from "../src/app.ts";
import { ensureOrganization } from "../src/auth/bootstrap.ts";
import { loadAuthConfig } from "../src/auth/config.ts";
import { createBrevoMailer } from "../src/auth/mailer.ts";
import { auth as bearer, startTestServer, type TestServer } from "./helpers.ts";

// TASK 06 integration tests. Real HTTP -> Express 5 -> Better Auth -> Prisma 7 -> embedded
// Postgres with the real migrations. Only the mailer is in-memory (no email is ever sent).

let s: TestServer;
let n = 0;
const PASSWORD = "correct-horse-1";

beforeAll(async () => {
	s = await startTestServer({ auth: true });
}, 120_000);
afterAll(async () => {
	await s?.stop();
});

/** A fresh client address per case, so the rate limiter does not couple tests. */
const ip = () => `10.0.${Math.floor(++n / 250)}.${n % 250}`;

function cookiesOf(res: Response): string {
	return res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0]!)
		.filter((c) => !/=$/.test(c))
		.join("; ");
}

async function post(path: string, body: unknown, h: Record<string, string> = {}) {
	return fetch(`${s.base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: s.origin, "x-forwarded-for": ip(), ...h },
		body: JSON.stringify(body),
	});
}

async function register(email: string) {
	const r = await post("/api/auth/sign-up/email", { email, password: PASSWORD, name: email.split("@")[0] });
	expect(r.status).toBe(200);
	const mail = s.mail.outbox.filter((m) => m.to === email).at(-1)!;
	const link = /(https?:\/\/\S+)/.exec(mail.text)![1]!;
	const verify = await fetch(link.replace(s.origin, s.base), { redirect: "manual" });
	expect([200, 302]).toContain(verify.status);
}

async function signIn(email: string, password = PASSWORD, clientIp = ip()) {
	const r = await post("/api/auth/sign-in/email", { email, password }, { "x-forwarded-for": clientIp });
	return { res: r, cookie: cookiesOf(r) };
}

const call = (path: string, cookie: string, init: { method?: string; body?: unknown; origin?: string | null } = {}) =>
	fetch(`${s.base}${path}`, {
		method: init.method ?? "GET",
		headers: {
			cookie,
			"content-type": "application/json",
			...(init.origin === null ? {} : { origin: init.origin ?? s.origin }),
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});

async function user(email: string) {
	await register(email);
	const { res, cookie } = await signIn(email);
	expect(res.status).toBe(200);
	return cookie;
}

const recipient = { name: "Ana", kind: "individual", country: "GB" };

describe("registration, login, logout, session replay", () => {
	it("register -> verify -> login -> authenticated API -> logout; replay fails", async () => {
		const email = "flow@example.com";
		const r = await post("/api/auth/sign-up/email", { email, password: PASSWORD, name: "Flow" });
		expect(r.status).toBe(200);
		expect(cookiesOf(r)).toBe(""); // no session before verification

		// Unverified login is refused.
		const early = await signIn(email);
		expect(early.res.status).toBe(403);
		expect(early.cookie).toBe("");

		const link = /(https?:\/\/\S+)/.exec(s.mail.outbox.filter((m) => m.to === email).at(-1)!.text)![1]!;
		await fetch(link.replace(s.origin, s.base), { redirect: "manual" });

		const { res, cookie } = await signIn(email);
		expect(res.status).toBe(200);
		const setCookie = res.headers.getSetCookie().join("\n");
		expect(setCookie).toMatch(/HttpOnly/i);
		expect(setCookie).toMatch(/SameSite=Lax/i);

		const me = await call("/v1/me", cookie);
		expect(me.status).toBe(200);
		const body = (await me.json()) as { via: string; user: { email: string }; organization: { id: string } };
		expect(body.via).toBe("session");
		expect(body.user.email).toBe(email);

		const created = await call("/v1/recipients", cookie, { method: "POST", body: recipient });
		expect(created.status).toBe(201);

		const out = await call("/api/auth/sign-out", cookie, { method: "POST", body: {} });
		expect(out.status).toBe(200);

		// The pre-logout cookie must not authenticate any more.
		expect((await call("/v1/me", cookie)).status).toBe(401);
		expect((await call("/v1/recipients", cookie, { method: "POST", body: recipient })).status).toBe(401);
		expect(await s.db.authSession.count({ where: { user: { email } } })).toBe(0);
	});

	it("unauthenticated and garbage access to protected routes is denied", async () => {
		expect((await fetch(`${s.base}/v1/recipients`)).status).toBe(401);
		expect((await fetch(`${s.base}/v1/me`)).status).toBe(401);
		expect((await call("/v1/me", "fp.session_token=forged.value")).status).toBe(401);
		expect(
			(await fetch(`${s.base}/v1/recipients`, { headers: { authorization: "Bearer nope" } })).status,
		).toBe(401);
	});
});

describe("tenant isolation", () => {
	it("a user only sees and changes their own organization", async () => {
		const a = await user("tenant-a@example.com");
		const b = await user("tenant-b@example.com");
		expect((await call("/v1/recipients", a, { method: "POST", body: recipient })).status).toBe(201);

		const listA = (await (await call("/v1/recipients", a)).json()) as { recipients: unknown[] };
		const listB = (await (await call("/v1/recipients", b)).json()) as { recipients: unknown[] };
		expect(listA.recipients).toHaveLength(1);
		expect(listB.recipients).toHaveLength(0);

		const meA = (await (await call("/v1/me", a)).json()) as { organization: { id: string } };
		const meB = (await (await call("/v1/me", b)).json()) as { organization: { id: string } };
		expect(meA.organization.id).not.toBe(meB.organization.id);

		// A key minted by A cannot be revoked (or even seen) by B.
		const key = (await (await call("/v1/api-keys", a, { method: "POST", body: { label: "srv" } })).json()) as {
			id: string;
		};
		expect((await call(`/v1/api-keys/${key.id}/revoke`, b, { method: "POST", body: {} })).status).toBe(404);
		const keysB = (await (await call("/v1/api-keys", b)).json()) as { keys: unknown[] };
		expect(keysB.keys).toHaveLength(0);
	});
});

describe("sessions are separate from API keys", () => {
	it("a customer session cannot run sandbox admin operations; an API key still can", async () => {
		const c = await user("sandbox@example.com");
		for (const [path, body] of [
			["/v1/sandbox/advance-time", { seconds: 5 }],
			["/v1/sandbox/reset", {}],
			["/v1/sandbox/provider-health", { providerId: "x", health: "down" }],
			["/v1/sandbox/fail-next", { providerId: "x" }],
		] as const) {
			const r = await call(path, c, { method: "POST", body });
			expect(r.status, path).toBe(401);
		}
		const { key } = await s.newOrg("keyorg");
		const ok = await fetch(`${s.base}/v1/sandbox/advance-time`, {
			method: "POST",
			headers: bearer(key),
			body: JSON.stringify({ seconds: 1 }),
		});
		expect(ok.status).toBe(200);
		await fetch(`${s.base}/v1/sandbox/reset`, { method: "POST", headers: bearer(key), body: "{}" });
	});

	it("API keys cannot manage API keys; a session-minted key works and can be revoked", async () => {
		const c = await user("keys@example.com");
		const { key: oldKey } = await s.newOrg("other");
		expect(
			(await fetch(`${s.base}/v1/api-keys`, { method: "POST", headers: bearer(oldKey), body: "{}" })).status,
		).toBe(401);

		const made = await call("/v1/api-keys", c, { method: "POST", body: { label: "server" } });
		expect(made.status).toBe(201);
		const k = (await made.json()) as { id: string; key: string };
		const viaKey = await fetch(`${s.base}/v1/me`, { headers: bearer(k.key) });
		expect(((await viaKey.json()) as { via: string }).via).toBe("api_key");

		expect((await call(`/v1/api-keys/${k.id}/revoke`, c, { method: "POST", body: {} })).status).toBe(200);
		expect((await fetch(`${s.base}/v1/me`, { headers: bearer(k.key) })).status).toBe(401);
		// The key list never contains a secret.
		const list = JSON.stringify(await (await call("/v1/api-keys", c)).json());
		expect(list).not.toContain(k.key);
	});

	it("a bad API key never falls back to a valid cookie", async () => {
		const c = await user("nofallback@example.com");
		const r = await fetch(`${s.base}/v1/me`, { headers: { cookie: c, authorization: "Bearer wrong" } });
		expect(r.status).toBe(401);
	});
});

describe("Origin / CSRF", () => {
	it("rejects cookie-authenticated mutations from an untrusted or missing Origin", async () => {
		const c = await user("csrf@example.com");
		for (const origin of ["https://evil.example", null]) {
			const r = await call("/v1/recipients", c, { method: "POST", body: recipient, origin });
			expect(r.status, String(origin)).toBe(403);
		}
		expect((await call("/v1/recipients", c, { method: "POST", body: recipient })).status).toBe(201);
		// Reads need no Origin.
		expect((await call("/v1/recipients", c, { origin: null })).status).toBe(200);
		// Better Auth's own endpoints are protected too.
		const out = await call("/api/auth/sign-out", c, { method: "POST", body: {}, origin: "https://evil.example" });
		expect(out.status).toBe(403);
		expect((await call("/v1/me", c)).status).toBe(200); // still signed in
	});

	it("rejects a cross-origin sign-in attempt", async () => {
		await register("csrf2@example.com");
		const r = await post(
			"/api/auth/sign-in/email",
			{ email: "csrf2@example.com", password: PASSWORD },
			{ origin: "https://evil.example" },
		);
		expect(r.status).toBe(403);
	});
});

describe("password reset", () => {
	it("revokes every existing session and the old password", async () => {
		const email = "reset@example.com";
		await register(email);
		const one = (await signIn(email)).cookie;
		const two = (await signIn(email)).cookie;
		expect((await call("/v1/me", one)).status).toBe(200);
		expect((await call("/v1/me", two)).status).toBe(200);

		const req = await post("/api/auth/request-password-reset", { email, redirectTo: `${s.origin}/reset` });
		expect(req.status).toBe(200);
		const mail = s.mail.outbox.filter((m) => m.to === email && /Reset/.test(m.subject)).at(-1)!;
		const token = /reset-password\/([^?\s]+)/.exec(mail.text)![1]!;

		const reset = await post("/api/auth/reset-password", { newPassword: "brand-new-pass-9", token });
		expect(reset.status).toBe(200);

		expect((await call("/v1/me", one)).status).toBe(401);
		expect((await call("/v1/me", two)).status).toBe(401);
		expect((await signIn(email, PASSWORD)).res.status).toBe(401);
		expect((await signIn(email, "brand-new-pass-9")).res.status).toBe(200);
		// The reset token is single use.
		expect((await post("/api/auth/reset-password", { newPassword: "another-pass-77", token })).status).not.toBe(200);
	});

	it("does not reveal whether an email exists", async () => {
		const r = await post("/api/auth/request-password-reset", {
			email: "nobody@example.com",
			redirectTo: `${s.origin}/reset`,
		});
		expect(r.status).toBe(200);
		expect(s.mail.outbox.some((m) => m.to === "nobody@example.com")).toBe(false);
	});
});

describe("rate limiting", () => {
	it("throttles repeated sign-in attempts per client, not globally", async () => {
		const attacker = "203.0.113.9";
		const statuses: number[] = [];
		for (let i = 0; i < 12; i++) {
			const r = await post(
				"/api/auth/sign-in/email",
				{ email: "x@example.com", password: "wrong-password" },
				{ "x-forwarded-for": attacker },
			);
			statuses.push(r.status);
		}
		expect(statuses.slice(0, 10).every((x) => x !== 429)).toBe(true);
		expect(statuses.slice(10)).toEqual([429, 429]);
		const limited = await post(
			"/api/auth/sign-in/email",
			{ email: "x@example.com", password: "p" },
			{ "x-forwarded-for": attacker },
		);
		expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
		// Another client is unaffected.
		const other = await post("/api/auth/sign-in/email", { email: "x@example.com", password: "wrong-password" });
		expect(other.status).not.toBe(429);
	});

	it("throttles sign-up and password-reset requests", async () => {
		const bot = "203.0.113.50";
		const codes: number[] = [];
		for (let i = 0; i < 7; i++) {
			const r = await post(
				"/api/auth/sign-up/email",
				{ email: `bot${i}@example.com`, password: PASSWORD, name: "b" },
				{ "x-forwarded-for": bot },
			);
			codes.push(r.status);
		}
		expect(codes.slice(5)).toEqual([429, 429]);
		const rec = "203.0.113.51";
		const rc: number[] = [];
		for (let i = 0; i < 7; i++) {
			const r = await post(
				"/api/auth/request-password-reset",
				{ email: "a@example.com", redirectTo: `${s.origin}/r` },
				{ "x-forwarded-for": rec },
			);
			rc.push(r.status);
		}
		expect(rc.slice(5)).toEqual([429, 429]);
	});
});

describe("organization bootstrap", () => {
	it("concurrent bootstraps create exactly one organization and membership", async () => {
		const u = await s.db.authUser.create({
			data: { id: "usr_race", name: "Race", email: "race@example.com", emailVerified: true },
		});
		const results = await Promise.all(Array.from({ length: 8 }, () => ensureOrganization(s.db, u)));
		expect(new Set(results.map((r) => r.id)).size).toBe(1);
		expect(await s.db.membership.count({ where: { userId: u.id } })).toBe(1);
		expect(await s.db.organization.count({ where: { memberships: { some: { userId: u.id } } } })).toBe(1);
	});

	it("recovers lazily when the sign-up hook did not bootstrap", async () => {
		const c = await user("recover@example.com");
		const me = (await (await call("/v1/me", c)).json()) as { organization: { id: string }; user: { id: string } };
		await s.db.membership.deleteMany({ where: { userId: me.user.id } });
		const again = (await (await call("/v1/me", c)).json()) as { organization: { id: string } };
		expect(again.organization.id).toBeTruthy();
		expect(await s.db.membership.count({ where: { userId: me.user.id } })).toBe(1);
	});
});

describe("public ClaimLink and fail-closed behaviour", () => {
	it("public claim routes need no credentials and are not weakened", async () => {
		const r = await fetch(`${s.base}/v1/claims/not-a-real-token`);
		expect(r.status).not.toBe(401);
		expect([400, 404]).toContain(r.status);
		expect((await fetch(`${s.base}/healthz`)).status).toBe(200);
	});

	it("with auth unconfigured, /api/auth is 503 and cookies are never accepted; API keys still work", async () => {
		const loaded = await loadConfig(resolve(fileURLToPath(new URL("../../../config", import.meta.url))));
		if (!loaded.ok) throw new Error("config");
		const app = createApp({ db: s.db, config: loaded.config, runtime: s.runtime }).listen(0, "127.0.0.1");
		await new Promise((r) => app.once("listening", r));
		const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
		try {
			expect((await fetch(`${base}/api/auth/sign-in/email`, { method: "POST" })).status).toBe(503);
			const c = await user("failclosed@example.com");
			expect((await fetch(`${base}/v1/me`, { headers: { cookie: c } })).status).toBe(401);
			const { key } = await s.newOrg("fc");
			expect((await fetch(`${base}/v1/me`, { headers: bearer(key) })).status).toBe(200);
		} finally {
			await new Promise((r) => app.close(r));
		}
	});
});

describe("configuration: unit tests, no network", () => {
	const rnd = () => "r".repeat(40);
	const prod = {
		NODE_ENV: "production",
		BETTER_AUTH_SECRET: "s".repeat(40),
		WEB_ORIGIN: "https://app.example.test",
		BREVO_API_KEY: "xkeysib-placeholder",
		BREVO_SENDER_EMAIL: "noreply@example.test",
	};

	it("production has no fallback secret and requires every credential", () => {
		expect(loadAuthConfig(prod, rnd).ok).toBe(true);
		for (const drop of ["BETTER_AUTH_SECRET", "WEB_ORIGIN", "BREVO_API_KEY", "BREVO_SENDER_EMAIL"]) {
			const env: Record<string, string | undefined> = { ...prod };
			delete env[drop];
			expect(loadAuthConfig(env, rnd).ok, drop).toBe(false);
		}
		expect(loadAuthConfig({ ...prod, BETTER_AUTH_SECRET: "short" }, rnd).ok).toBe(false);
		expect(loadAuthConfig({ ...prod, WEB_ORIGIN: "http://app.example.test" }, rnd).ok).toBe(false);
		expect(loadAuthConfig({ ...prod, BREVO_API_KEY: undefined, FP_MAIL_DEV_CONSOLE: "1" }, rnd).ok).toBe(false);
		const ok = loadAuthConfig(prod, rnd);
		if (ok.ok) expect(ok.config.secureCookies).toBe(true);
	});

	it("outside production a random secret is generated, never a constant", () => {
		const a = loadAuthConfig({ FP_MAIL_DEV_CONSOLE: "1" }, () => "a".repeat(40));
		expect(a.ok && a.config.secret).toBe("a".repeat(40));
		expect(loadAuthConfig({}, rnd).ok).toBe(false); // no mail provider
	});

	it("Brevo mailer sends the documented request and never leaks the key in errors", async () => {
		const seen: { url: string; init: RequestInit }[] = [];
		const okFetch = (async (url: string, init: RequestInit) => {
			seen.push({ url, init });
			return new Response("{}", { status: 201 });
		}) as unknown as typeof fetch;
		await createBrevoMailer("KEY-123", "from@example.test", "FlexiPay", okFetch).send({
			to: "to@example.test",
			subject: "s",
			text: "t",
		});
		expect(seen[0]!.url).toBe("https://api.brevo.com/v3/smtp/email");
		expect((seen[0]!.init.headers as Record<string, string>)["api-key"]).toBe("KEY-123");
		expect(JSON.parse(seen[0]!.init.body as string)).toMatchObject({
			sender: { email: "from@example.test" },
			to: [{ email: "to@example.test" }],
			textContent: "t",
		});
		const badFetch = (async () => new Response("key KEY-123 invalid", { status: 401 })) as unknown as typeof fetch;
		const err = await createBrevoMailer("KEY-123", "f@example.test", "x", badFetch)
			.send({ to: "a@b.test", subject: "s", text: "t" })
			.catch((e: Error) => e);
		expect((err as Error).message).toMatch(/HTTP 401/);
		expect((err as Error).message).not.toContain("KEY-123");
	});
});
