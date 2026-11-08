import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { ROUTES } from "../src/app.ts";
import { newId } from "../src/ids.ts";
import { resetSolanaRuntimeConfigCache } from "../src/solana/runtime-config.ts";
import { setReferenceThrottleMsForTests } from "../src/solana/reference.ts";
import type { RouteDef } from "../src/routes.ts";
import { auth as bearer, startTestServer, type TestServer } from "./helpers.ts";

// Table-driven authorization and validation checks over the live route table (app.ts ROUTES).
// Every route is walked, so a new route is covered automatically; a new route with a path
// parameter fails the "fixture" check until it gets a cross-organization case below.

let s: TestServer;
let n = 0;
const PASSWORD = "correct-horse-1";
const SIG = "5".repeat(88);
const ip = () => `10.9.${Math.floor(++n / 250)}.${n % 250}`;

/** Org A owns the resources; org B and the signed-in customer (org S) are strangers to them. */
let A: { orgId: string; key: string };
let B: { orgId: string; key: string };
let cookieS = "";
let orgS = "";
const owned: Record<string, string> = {};

const prevEnv: Record<string, string | undefined> = {};
const ENV = {
	FP_SOLANA_CLUSTER: "devnet",
	FP_SOLANA_USDC_MINT: Keypair.generate().publicKey.toBase58(),
	FP_SOLANA_USDC_DECIMALS: "6",
	FP_SOLANA_TGBP_MINT: Keypair.generate().publicKey.toBase58(),
	FP_SOLANA_TGBP_DECIMALS: "6",
};

function cookiesOf(res: Response): string {
	return res.headers
		.getSetCookie()
		.map((c) => c.split(";")[0]!)
		.filter((c) => !/=$/.test(c))
		.join("; ");
}

async function signUpAndIn(email: string): Promise<string> {
	const h = { "content-type": "application/json", origin: s.origin, "x-forwarded-for": ip() };
	const r = await fetch(`${s.base}/api/auth/sign-up/email`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ email, password: PASSWORD, name: "Matrix" }),
	});
	expect(r.status).toBe(200);
	const mail = s.mail.outbox.filter((m) => m.to === email).at(-1)!;
	const link = /(https?:\/\/\S+)/.exec(mail.text)![1]!;
	await fetch(link.replace(s.origin, s.base), { redirect: "manual" });
	const signIn = await fetch(`${s.base}/api/auth/sign-in/email`, {
		method: "POST",
		headers: { ...h, "x-forwarded-for": ip() },
		body: JSON.stringify({ email, password: PASSWORD }),
	});
	expect(signIn.status).toBe(200);
	return cookiesOf(signIn);
}

async function json(res: Response): Promise<any> {
	const text = await res.text();
	return text ? JSON.parse(text) : null;
}

beforeAll(async () => {
	for (const [k, v] of Object.entries(ENV)) {
		prevEnv[k] = process.env[k];
		process.env[k] = v;
	}
	resetSolanaRuntimeConfigCache();
	setReferenceThrottleMsForTests(0);
	s = await startTestServer({ auth: true, sandbox: true });
	A = await s.newOrg("Owner A");
	B = await s.newOrg("Stranger B");
	cookieS = await signUpAndIn("matrix-s@example.com");
	orgS = (await json(await fetch(`${s.base}/v1/me`, { headers: { cookie: cookieS } }))).organization.id;

	const post = async (path: string, body: unknown) => {
		const res = await fetch(`${s.base}${path}`, { method: "POST", headers: bearer(A.key), body: JSON.stringify(body) });
		const out = await json(res);
		expect(res.status, `${path}: ${JSON.stringify(out)}`).toBe(201);
		return out;
	};
	const recipient = await post("/v1/recipients", { name: "Worker A", kind: "individual", country: "US" });
	const quote = await post("/v1/quotes", {
		source: { type: "bank_account", currency: "USD", country: "US" },
		destination: { type: "bank_account", currency: "USD", country: "US", recipientKind: "individual" },
		amount: { side: "send", value: { amount: "10000", currency: "USD" } },
		policy: "cheapest",
	});
	const payment = await post("/v1/payments", {
		quoteId: quote.id,
		recipientId: recipient.id,
		delivery: "direct",
		profile: "one_off",
	});
	const request = await post("/v1/payment-requests", {
		amount: "1000",
		merchantWallet: Keypair.generate().publicKey.toBase58(),
	});
	const batchId = newId("bat");
	await s.db.batch.create({ data: { id: batchId, organizationId: A.orgId } });
	// A key of the signed-in organization's neighbour: org A's key row.
	const keyRow = await s.db.apiKey.findFirstOrThrow({ where: { organizationId: A.orgId } });
	Object.assign(owned, {
		recipient: recipient.id,
		quote: quote.id,
		payment: payment.id,
		paymentRequest: request.id,
		batch: batchId,
		apiKey: keyRow.id,
	});
}, 180_000);

afterAll(async () => {
	await s?.stop();
	for (const [k, v] of Object.entries(prevEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	resetSolanaRuntimeConfigCache();
	setReferenceThrottleMsForTests(null);
});

const label = (r: RouteDef<any, any>) => `${r.method.toUpperCase()} ${r.path}`;

/** Fills path parameters with placeholders (for checks that never reach a lookup). */
const placeholderPath = (p: string) => p.replace("{token}", "ab".repeat(32)).replace(/\{(\w+)\}/g, "x_$1");

function call(
	r: RouteDef<any, any>,
	opts: { path?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Response> {
	const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
	return fetch(`${s.base}${opts.path ?? placeholderPath(r.path)}`, {
		method: r.method.toUpperCase(),
		headers,
		body: r.method === "post" ? JSON.stringify(opts.body ?? {}) : undefined,
	});
}

const protectedRoutes = ROUTES.filter((r) => r.auth !== "none");

describe("route table invariants", () => {
	it("every route declares one of the four auth modes and public routes are claim/health/config only", () => {
		for (const r of ROUTES) {
			expect(["api_key", "customer", "session", "none"], label(r)).toContain(r.auth);
			if (r.auth === "none") {
				expect(
					r.path === "/healthz" ||
						r.path === "/v1/solana/config" ||
						r.path === "/v1/webhooks/blindpay" ||
						r.path.startsWith("/v1/claims/{token}"),
					`${label(r)} is public; add it here only on purpose`,
				).toBe(true);
			}
		}
		// Operator and sandbox routes are never customer-session routes.
		for (const r of ROUTES.filter((x) => x.path.startsWith("/v1/ops/") || x.path.startsWith("/v1/sandbox/"))) {
			expect(r.auth, label(r)).toBe("api_key");
		}
		for (const r of ROUTES.filter((x) => x.path.startsWith("/v1/sandbox/"))) {
			expect(r.gate, label(r)).toBe("sandbox");
		}
	});
});

describe("no credentials → 401 on every protected route", () => {
	it.each(protectedRoutes.map((r) => [label(r), r] as const))("%s", async (_name, r) => {
		// Trusted origin and no cookie: the request reaches authentication and is refused.
		const res = await call(r, { headers: { origin: s.origin } });
		expect(res.status).toBe(401);
		expect((await json(res)).code).toBe("unauthorized");
		// No origin either: a mutation is refused before the cookie is even read (403), never served.
		const bare = await call(r);
		expect([401, 403]).toContain(bare.status);
	});

	it.each(protectedRoutes.map((r) => [label(r), r] as const))("%s refuses unknown and revoked keys", async (_name, r) => {
		if (r.auth === "session") return; // keys are refused there anyway (next block)
		for (const authorization of ["Bearer fp_test_unknown", "Basic abc", "Bearer"]) {
			const res = await call(r, { headers: { authorization } });
			expect(res.status, authorization).toBe(401);
		}
	});

	it("a revoked API key is refused everywhere it used to work", async () => {
		const c = await s.newOrg("Revoked Org");
		await s.db.apiKey.updateMany({ where: { organizationId: c.orgId }, data: { revokedAt: new Date() } });
		for (const r of protectedRoutes.filter((x) => x.auth !== "session")) {
			const res = await call(r, { headers: { authorization: `Bearer ${c.key}` } });
			expect(res.status, label(r)).toBe(401);
		}
	});
});

describe("session vs api_key modes", () => {
	it.each(ROUTES.filter((r) => r.auth === "session").map((r) => [label(r), r] as const))(
		"%s refuses a valid API key (session only)",
		async (_name, r) => {
			const res = await call(r, { headers: { authorization: `Bearer ${A.key}` } });
			expect(res.status).toBe(401);
		},
	);

	it.each(ROUTES.filter((r) => r.auth === "api_key").map((r) => [label(r), r] as const))(
		"%s refuses a valid customer session (API key only)",
		async (_name, r) => {
			const res = await call(r, { headers: { cookie: cookieS, origin: s.origin } });
			expect(res.status).toBe(401);
		},
	);

	it.each(ROUTES.filter((r) => r.auth === "customer").map((r) => [label(r), r] as const))(
		"%s accepts both a key and a session (never 401 for either)",
		async (_name, r) => {
			const viaKey = await call(r, { headers: { authorization: `Bearer ${B.key}` } });
			expect(viaKey.status).not.toBe(401);
			const viaSession = await call(r, { headers: { cookie: cookieS, origin: s.origin } });
			expect(viaSession.status).not.toBe(401);
		},
	);

	it.each(ROUTES.filter((r) => r.auth === "customer" && r.method === "post").map((r) => [label(r), r] as const))(
		"%s refuses a session mutation from an untrusted origin",
		async (_name, r) => {
			const res = await call(r, { headers: { cookie: cookieS, origin: "https://evil.example" } });
			expect(res.status).toBe(403);
			expect((await json(res)).code).toBe("forbidden_origin");
		},
	);

	it("a bad Authorization header never falls back to a valid session cookie", async () => {
		for (const r of ROUTES.filter((x) => x.auth === "customer")) {
			const res = await call(r, { headers: { cookie: cookieS, origin: s.origin, authorization: "Bearer nope" } });
			expect(res.status, label(r)).toBe(401);
		}
	});

	it.each(ROUTES.filter((r) => r.auth === "none").map((r) => [label(r), r] as const))(
		"%s is public: no credentials is never a 401",
		async (_name, r) => {
			const res = await call(r);
			expect(res.status).not.toBe(401);
		},
	);
});

/**
 * Cross-organization cases for every route with a path parameter. The resource belongs to
 * org A; the caller is org B (key) or org S (session). Expected: 404, and nothing changes.
 */
const CROSS_ORG: Record<string, { path: () => string; body?: unknown }> = {
	"GET /v1/quotes/{id}": { path: () => `/v1/quotes/${owned.quote}` },
	"GET /v1/payments/{id}": { path: () => `/v1/payments/${owned.payment}` },
	"POST /v1/payments/{id}/fund": { path: () => `/v1/payments/${owned.payment}/fund` },
	"POST /v1/payments/{id}/cancel": { path: () => `/v1/payments/${owned.payment}/cancel` },
	"GET /v1/payments/{id}/solana/intent": { path: () => `/v1/payments/${owned.payment}/solana/intent` },
	"POST /v1/payments/{id}/solana/confirm": {
		path: () => `/v1/payments/${owned.payment}/solana/confirm`,
		body: { signature: SIG },
	},
	"POST /v1/payments/{id}/blindpay/delegation": {
		path: () => `/v1/payments/${owned.payment}/blindpay/delegation`,
		body: { ownerAddress: "1".repeat(32) },
	},
	"POST /v1/payments/{id}/blindpay/confirm": {
		path: () => `/v1/payments/${owned.payment}/blindpay/confirm`,
		body: { signature: SIG },
	},
	"GET /v1/batches/{id}": { path: () => `/v1/batches/${owned.batch}` },
	"GET /v1/payment-requests/{id}": { path: () => `/v1/payment-requests/${owned.paymentRequest}` },
	"POST /v1/api-keys/{id}/revoke": { path: () => `/v1/api-keys/${owned.apiKey}/revoke`, body: {} },
};

const paramRoutes = protectedRoutes.filter((r) => /\{\w+\}/.test(r.path));

describe("another organization's resource → 404", () => {
	it("every protected route with a path parameter has a cross-organization case", () => {
		const missing = paramRoutes.map(label).filter((l) => !CROSS_ORG[l]);
		expect(missing, "add a CROSS_ORG entry for these routes").toEqual([]);
		// And no stale entries.
		const known = new Set(paramRoutes.map(label));
		expect(Object.keys(CROSS_ORG).filter((k) => !known.has(k))).toEqual([]);
	});

	it.each(paramRoutes.map((r) => [label(r), r] as const))("%s", async (name, r) => {
		const c = CROSS_ORG[name]!;
		const before = await s.db.payment.findUniqueOrThrow({ where: { id: owned.payment } });
		const keyBefore = await s.db.apiKey.findUniqueOrThrow({ where: { id: owned.apiKey } });
		const callers: Record<string, string>[] = [];
		if (r.auth !== "session") callers.push({ authorization: `Bearer ${B.key}` });
		if (r.auth !== "api_key") callers.push({ cookie: cookieS, origin: s.origin });
		for (const headers of callers) {
			const res = await call(r, { path: c.path(), headers, body: c.body });
			const out = await json(res);
			expect(res.status, `${name} as ${Object.keys(headers)[0]}: ${JSON.stringify(out)}`).toBe(404);
			expect(out.code).toBe("not_found");
			expect(JSON.stringify(out)).not.toContain(A.orgId);
		}
		const after = await s.db.payment.findUniqueOrThrow({ where: { id: owned.payment } });
		expect(after.status).toBe(before.status);
		expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
		expect((await s.db.apiKey.findUniqueOrThrow({ where: { id: owned.apiKey } })).revokedAt).toEqual(keyBefore.revokedAt);
	});

	it("the owner still reaches each of those resources (the 404 is about ownership, not the id)", async () => {
		for (const r of paramRoutes.filter((x) => x.method === "get")) {
			const res = await call(r, { path: CROSS_ORG[label(r)]!.path(), headers: { authorization: `Bearer ${A.key}` } });
			expect(res.status, label(r)).not.toBe(404);
		}
	});

	it.each(
		protectedRoutes
			.filter((r) => r.method === "get" && !/\{\w+\}/.test(r.path) && r.auth !== "api_key")
			.map((r) => [label(r), r] as const),
	)("%s list never shows org A's data to a stranger", async (_name, r) => {
		const callers: Record<string, string>[] = [{ cookie: cookieS, origin: s.origin }];
		if (r.auth !== "session") callers.push({ authorization: `Bearer ${B.key}` });
		// Required query so a lookup route still returns 200 without reading another org's rows.
		const query =
			r.path === "/v1/payout-requirements" ? "?country=US&currency=USD" : "";
		for (const headers of callers) {
			const res = await call(r, { headers, path: `${r.path}${query}` });
			expect(res.status).toBe(200);
			const text = await res.text();
			for (const id of [A.orgId, owned.payment, owned.recipient, owned.apiKey]) {
				expect(text, `${label(r)} leaks ${id}`).not.toContain(id);
			}
		}
	});
});

describe("operator routes (/v1/ops/*)", () => {
	const opsRoutes = ROUTES.filter((r) => r.path.startsWith("/v1/ops/"));

	it("exist", () => {
		expect(opsRoutes.length).toBeGreaterThan(0);
	});

	it.each(opsRoutes.map((r) => [label(r), r] as const))(
		"%s is 404 for a customer key, 200 only for an org in FP_OPERATOR_ORG_IDS",
		async (_name, r) => {
			const prev = process.env.FP_OPERATOR_ORG_IDS;
			try {
				delete process.env.FP_OPERATOR_ORG_IDS;
				// Unset means closed, even for the would-be operator.
				expect((await call(r, { headers: { authorization: `Bearer ${A.key}` } })).status).toBe(404);
				process.env.FP_OPERATOR_ORG_IDS = ` ${B.orgId} , ${orgS} `;
				const customer = await call(r, { headers: { authorization: `Bearer ${A.key}` } });
				expect(customer.status).toBe(404);
				expect((await json(customer)).code).toBe("not_found");
				const operator = await call(r, { headers: { authorization: `Bearer ${B.key}` } });
				expect(operator.status).toBe(200);
				// Even an operator org cannot use a customer session here.
				expect((await call(r, { headers: { cookie: cookieS, origin: s.origin } })).status).toBe(401);
			} finally {
				if (prev === undefined) delete process.env.FP_OPERATOR_ORG_IDS;
				else process.env.FP_OPERATOR_ORG_IDS = prev;
			}
		},
	);
});

describe("strict bodies: unknown fields → 400 validation_error", () => {
	// BlindPay's webhook body is their payload. The signature check accepts it; a closed
	// schema would reject fields BlindPay adds.
	const posts = ROUTES.filter(
		(r) => r.method === "post" && r.path !== "/v1/webhooks/blindpay",
	);

	function credentialsFor(r: RouteDef<any, any>): Record<string, string> {
		if (r.auth === "session") return { cookie: cookieS, origin: s.origin };
		if (r.auth === "none") return { "idempotency-key": `strict-${Math.random()}` };
		return { authorization: `Bearer ${B.key}` };
	}

	it.each(posts.filter((r) => r.body).map((r) => [label(r), r] as const))("%s", async (_name, r) => {
		const res = await call(r, { headers: credentialsFor(r), body: { zzUnknownField: 1 } });
		const out = await json(res);
		expect(res.status, JSON.stringify(out)).toBe(400);
		expect(out.code).toBe("validation_error");
		const unknown = (out.details as Array<{ code: string; path: unknown[]; keys?: string[] }>).find(
			(i) => i.code === "unrecognized_keys",
		);
		expect(unknown, "the unknown top-level field is reported").toBeDefined();
		expect(unknown!.path).toEqual([]);
		expect(unknown!.keys).toContain("zzUnknownField");
	});

	it("a malformed JSON body is 400 invalid_json", async () => {
		const res = await fetch(`${s.base}/v1/recipients`, {
			method: "POST",
			headers: bearer(B.key),
			body: "{not json",
		});
		expect(res.status).toBe(400);
		expect((await json(res)).code).toBe("invalid_json");
	});

	it("every POST has a body schema (fund and cancel fixed 7 Nov)", () => {
		expect(posts.filter((r) => !r.body).map(label)).toEqual([]);
	});
});
