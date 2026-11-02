import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import { Keypair } from "@solana/web3.js";
import { auth as bearer, startTestServer, type TestServer } from "./helpers.ts";
import { resetSolanaRuntimeConfigCache } from "../src/solana/runtime-config.ts";
import { setSolanaVerifyForTests } from "../src/solana/verify.ts";

// The two Solana payment routes accept a signed-in customer (or an API key) and are scoped to
// the caller's organization, exactly like every other payment route:
//   GET  /v1/payments/{id}/solana/intent
//   POST /v1/payments/{id}/solana/confirm
// Real HTTP + real Better Auth sessions + real Postgres. Only the Solana RPC verifier is stubbed
// (as in solana-confirm.test.ts); F3-F9 verification itself is covered there and re-run in CI.

const recipientAddr = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
const flexipayMinor = "10000000";
const PASSWORD = "correct-horse-1";

let s: TestServer;
let n = 0;
let verifyCalls = 0;

beforeAll(async () => {
	process.env.FP_SETTLEMENT = "mock";
	process.env.FP_SOLANA_CLUSTER = "devnet";
	process.env.FP_SOLANA_USDC_MINT = mint;
	process.env.FP_SOLANA_USDC_DECIMALS = "7";
	delete process.env.FP_SOLANA_PUBLIC_RPC_URL;
	resetSolanaRuntimeConfigCache();
	s = await startTestServer({ auth: true });
}, 120_000);
afterAll(async () => {
	setSolanaVerifyForTests(null);
	resetSolanaRuntimeConfigCache();
	try {
		await s?.stop();
	} catch (cause) {
		if (!/EBUSY|resource busy|locked/i.test(String(cause))) throw cause;
	}
});
afterEach(() => {
	verifyCalls = 0;
});

const ip = () => `10.7.${Math.floor(++n / 250)}.${n % 250}`;

async function signedInCookie(email: string): Promise<string> {
	const h = { "content-type": "application/json", origin: s.origin, "x-forwarded-for": ip() };
	const up = await fetch(`${s.base}/api/auth/sign-up/email`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ email, password: PASSWORD, name: "Cust" }),
	});
	assert.equal(up.status, 200);
	const link = /(https?:\/\/\S+)/.exec(s.mail.outbox.filter((m) => m.to === email).at(-1)!.text)![1]!;
	await fetch(link.replace(s.origin, s.base), { redirect: "manual" });
	const inn = await fetch(`${s.base}/api/auth/sign-in/email`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ email, password: PASSWORD }),
	});
	assert.equal(inn.status, 200);
	return inn.headers
		.getSetCookie()
		.map((c) => c.split(";")[0]!)
		.join("; ");
}

const withCookie = (cookie: string, extra: Record<string, string> = {}) => ({
	cookie,
	origin: s.origin,
	"content-type": "application/json",
	...extra,
});

async function session(cookie: string, path: string, body?: unknown, headers = withCookie(cookie)) {
	return fetch(`${s.base}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

/** A Solana payment owned by the signed-in customer, claim accepted and waiting for the transfer. */
async function solanaPaymentFor(cookie: string): Promise<string> {
	const post = async (path: string, body: unknown, status: number) => {
		const r = await session(cookie, path, body, withCookie(cookie, { "idempotency-key": `ca-${Math.random()}` }));
		const t = await r.text();
		assert.equal(r.status, status, `${path}: ${t}`);
		return JSON.parse(t) as Record<string, any>;
	};
	const rcp = await post("/v1/recipients", { name: "Recv", kind: "individual", country: "PH" }, 201);
	const quote = await post(
		"/v1/quotes",
		{
			source: { type: "bank_account", currency: "USD", country: "US" },
			destination: { type: "crypto_wallet", currency: "USDC", country: "PH", recipientKind: "individual" },
			amount: { side: "receive", value: { amount: flexipayMinor, currency: "USDC" } },
			policy: "cheapest",
			feeMode: "PayerPays",
		},
		201,
	);
	const payment = await post(
		"/v1/payments",
		{ quoteId: quote.id, recipientId: rcp.id, delivery: "claim_link", profile: "one_off" },
		201,
	);
	await post(`/v1/payments/${payment.id}/fund`, {}, 200);
	const token = String(payment.claimLink.url).split("/").pop()!;
	// Public ClaimLink accept: no cookie, no key.
	const accept = await fetch(`${s.base}/v1/claims/${token}/accept`, {
		method: "POST",
		headers: { "content-type": "application/json", "idempotency-key": `acc-${Math.random()}` },
		body: JSON.stringify({
			endpoint: {
				type: "crypto_wallet",
				country: "",
				currency: "USDC",
				network: "solana",
				details: { address: recipientAddr },
				simulated: true,
			},
		}),
	});
	assert.equal(accept.status, 200, await accept.text());
	return payment.id as string;
}

function stubVerifyOk() {
	setSolanaVerifyForTests(async (_rpc, input) => {
		verifyCalls += 1;
		return {
			ok: true,
			signature: input.signature,
			amountMinor: input.amountMinor,
			mint: input.mint,
			recipientOwner: input.recipientOwner,
			slot: 5,
			blockTime: Math.floor(Date.now() / 1000),
		};
	});
}

describe("Solana intent/confirm with customer sessions", () => {
	test("the owning signed-in customer can read the intent and confirm", async () => {
		stubVerifyOk();
		const owner = await signedInCookie("sol-owner@example.com");
		const id = await solanaPaymentFor(owner);

		const intent = await session(owner, `/v1/payments/${id}/solana/intent`);
		const text = await intent.text();
		assert.equal(intent.status, 200, text);
		const body = JSON.parse(text) as { recipient: string; reference: string };
		assert.equal(body.recipient, recipientAddr);

		const confirm = await session(
			owner,
			`/v1/payments/${id}/solana/confirm`,
			{ signature: "ok-sig-" + "1".repeat(52) },
			withCookie(owner, { "idempotency-key": "sess-conf-1" }),
		);
		const ctext = await confirm.text();
		assert.equal(confirm.status, 200, ctext);
		assert.equal((JSON.parse(ctext) as { paymentStatus: string }).paymentStatus, "paid");
	}, 120_000);

	test("unauthenticated and forged-cookie callers are rejected before any RPC", async () => {
		stubVerifyOk();
		const owner = await signedInCookie("sol-unauth@example.com");
		const id = await solanaPaymentFor(owner);

		// [headers, expected status for GET intent, expected status for POST confirm]
		// No credentials and no Origin: the existing Origin gate (TASK 06) answers 403 to the POST
		// before the session lookup; the GET is 401. Either way nothing reaches the RPC.
		const cases: [Record<string, string>, number, number][] = [
			[{ "content-type": "application/json" }, 401, 403],
			[
				{ "content-type": "application/json", cookie: "fp.session_token=forged.value", origin: s.origin },
				401,
				401,
			],
			[{ "content-type": "application/json", authorization: "Bearer not-a-key" }, 401, 401],
		];
		for (const [headers, getStatus, postStatus] of cases) {
			const i = await fetch(`${s.base}/v1/payments/${id}/solana/intent`, { headers });
			assert.equal(i.status, getStatus);
			const c = await fetch(`${s.base}/v1/payments/${id}/solana/confirm`, {
				method: "POST",
				headers,
				body: JSON.stringify({ signature: "x".repeat(60) }),
			});
			assert.equal(c.status, postStatus);
		}
		assert.equal(verifyCalls, 0);
		const row = await s.db.leg.findFirst({ where: { paymentId: id, kind: "settle" } });
		assert.equal(row?.status, "processing");
	}, 120_000);

	test("a valid session of ANOTHER customer cannot read or confirm someone else's payment", async () => {
		stubVerifyOk();
		const owner = await signedInCookie("sol-owner2@example.com");
		const other = await signedInCookie("sol-other@example.com");
		const id = await solanaPaymentFor(owner);

		const i = await session(other, `/v1/payments/${id}/solana/intent`);
		assert.equal(i.status, 404);
		const c = await session(
			other,
			`/v1/payments/${id}/solana/confirm`,
			{ signature: "ok-sig-" + "2".repeat(52) },
			withCookie(other, { "idempotency-key": "sess-conf-other" }),
		);
		assert.equal(c.status, 404);
		assert.equal(verifyCalls, 0);

		const settle = await s.db.leg.findFirst({ where: { paymentId: id, kind: "settle" } });
		assert.equal(settle?.status, "processing");
		assert.equal(settle?.releaseTxRef, null);
		const pay = await s.db.payment.findUnique({ where: { id } });
		assert.notEqual(pay?.status, "paid");

		// The owner is unaffected and can still complete it.
		const ok = await session(
			owner,
			`/v1/payments/${id}/solana/confirm`,
			{ signature: "ok-sig-" + "3".repeat(52) },
			withCookie(owner, { "idempotency-key": "sess-conf-owner" }),
		);
		assert.equal(ok.status, 200);
	}, 120_000);

	test("an API key of another organization is still rejected (unchanged ownership rule)", async () => {
		stubVerifyOk();
		const owner = await signedInCookie("sol-owner3@example.com");
		const id = await solanaPaymentFor(owner);
		const { key } = await s.newOrg("Other Org");
		const i = await fetch(`${s.base}/v1/payments/${id}/solana/intent`, { headers: bearer(key) });
		assert.equal(i.status, 404);
		const c = await fetch(`${s.base}/v1/payments/${id}/solana/confirm`, {
			method: "POST",
			headers: bearer(key, { "idempotency-key": "other-key" }),
			body: JSON.stringify({ signature: "k".repeat(60) }),
		});
		assert.equal(c.status, 404);
		assert.equal(verifyCalls, 0);
	}, 120_000);

	test("a cookie-authenticated confirm needs a trusted Origin (CSRF)", async () => {
		stubVerifyOk();
		const owner = await signedInCookie("sol-csrf@example.com");
		const id = await solanaPaymentFor(owner);
		for (const origin of ["https://evil.example", null]) {
			const headers: Record<string, string> = {
				cookie: owner,
				"content-type": "application/json",
				"idempotency-key": `csrf-${Math.random()}`,
			};
			if (origin) headers.origin = origin;
			const c = await fetch(`${s.base}/v1/payments/${id}/solana/confirm`, {
				method: "POST",
				headers,
				body: JSON.stringify({ signature: "c".repeat(60) }),
			});
			assert.equal(c.status, 403, String(origin));
		}
		assert.equal(verifyCalls, 0);
	}, 120_000);

	test("an API key minted for the owner's organization keeps working (server-to-server)", async () => {
		stubVerifyOk();
		const owner = await signedInCookie("sol-key@example.com");
		const id = await solanaPaymentFor(owner);
		const made = await session(owner, "/v1/api-keys", { label: "srv" });
		const { key } = (await made.json()) as { key: string };
		const i = await fetch(`${s.base}/v1/payments/${id}/solana/intent`, { headers: bearer(key) });
		assert.equal(i.status, 200);
	}, 120_000);

	test("F8 state check still runs for a session: confirm before the claim is accepted is refused without an RPC call", async () => {
		stubVerifyOk();
		const owner = await signedInCookie("sol-f8@example.com");
		const post = async (path: string, body: unknown) => {
			const r = await session(owner, path, body, withCookie(owner, { "idempotency-key": `f8-${Math.random()}` }));
			return JSON.parse(await r.text()) as Record<string, any>;
		};
		const rcp = await post("/v1/recipients", { name: "R", kind: "individual", country: "PH" });
		const quote = await post("/v1/quotes", {
			source: { type: "bank_account", currency: "USD", country: "US" },
			destination: { type: "crypto_wallet", currency: "USDC", country: "PH", recipientKind: "individual" },
			amount: { side: "receive", value: { amount: flexipayMinor, currency: "USDC" } },
			policy: "cheapest",
			feeMode: "PayerPays",
		});
		const payment = await post("/v1/payments", {
			quoteId: quote.id,
			recipientId: rcp.id,
			delivery: "claim_link",
			profile: "one_off",
		});
		const c = await session(
			owner,
			`/v1/payments/${payment.id}/solana/confirm`,
			{ signature: "f".repeat(60) },
			withCookie(owner, { "idempotency-key": "f8-conf" }),
		);
		assert.ok([409, 422].includes(c.status), `status ${c.status}`);
		assert.equal(verifyCalls, 0);
	}, 120_000);
});

describe("public ClaimLink and Stellar paths are unaffected", () => {
	test("claim GET needs no credentials", async () => {
		const r = await fetch(`${s.base}/v1/claims/not-a-real-token`);
		assert.notEqual(r.status, 401);
	});
});
