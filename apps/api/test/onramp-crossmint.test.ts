import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Keypair } from "@solana/web3.js";
import { startTestServer, type TestServer } from "./helpers.ts";
import { resetSolanaRuntimeConfigCache } from "../src/solana/runtime-config.ts";
import { createOnrampOrder, loadCrossmintConfig, OnrampError } from "../src/onramp/crossmint.ts";

// Crossmint card onramp (staging only). The provider is faked at the fetch boundary; the route
// itself runs over real HTTP with a real Better Auth session.

const wallet = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
const PASSWORD = "correct-horse-1";

describe("loadCrossmintConfig", () => {
	test("is on only for a staging key with CROSSMINT_ENV=staging", () => {
		expect(loadCrossmintConfig({})).toBeNull();
		expect(loadCrossmintConfig({ CROSSMINT_SERVER_KEY: "sk_staging_x" })).toBeNull();
		expect(loadCrossmintConfig({ CROSSMINT_SERVER_KEY: "sk_staging_x", CROSSMINT_ENV: "production" })).toBeNull();
		expect(loadCrossmintConfig({ CROSSMINT_SERVER_KEY: "sk_production_x", CROSSMINT_ENV: "staging" })).toBeNull();
		expect(loadCrossmintConfig({ CROSSMINT_SERVER_KEY: "sk_staging_x", CROSSMINT_ENV: "staging" })).toEqual({
			serverKey: "sk_staging_x",
			baseUrl: "https://staging.crossmint.com",
		});
	});
});

describe("createOnrampOrder", () => {
	const cfg = { serverKey: "sk_staging_secret", baseUrl: "https://staging.crossmint.com" };
	const input = { email: "a@b.co", walletAddress: wallet, amountUsd: "5", usdcMint: mint };

	test("links the wallet, then creates the order, and returns only id and secret", async () => {
		const calls: Array<{ url: string; method: string; body: unknown; key: string | null }> = [];
		const fake: typeof fetch = async (url, init) => {
			const headers = new Headers(init?.headers);
			calls.push({
				url: String(url),
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : null,
				key: headers.get("x-api-key"),
			});
			if (String(url).includes("linked-wallets")) return new Response("{}", { status: 200 });
			return new Response(JSON.stringify({ order: { orderId: "ord_1", phase: "payment" }, clientSecret: "cs_1" }), {
				status: 200,
			});
		};
		const out = await createOnrampOrder(cfg, input, fake);
		assert.deepEqual(out, { orderId: "ord_1", clientSecret: "cs_1" });
		assert.equal(calls.length, 2);
		assert.equal(calls[0]!.method, "PUT");
		assert.match(calls[0]!.url, /\/api\/2025-06-09\/users\/email:a%40b\.co\/linked-wallets\//);
		assert.deepEqual(calls[0]!.body, { chain: "solana" });
		assert.equal(calls[1]!.method, "POST");
		const order = calls[1]!.body as any;
		assert.equal(order.lineItems[0].tokenLocator, `solana:${mint}`);
		assert.equal(order.lineItems[0].executionParameters.amount, "5");
		assert.equal(order.recipient.walletAddress, wallet);
		assert.equal(calls[1]!.key, "sk_staging_secret");
	});

	test("an already-linked wallet (409) is fine", async () => {
		const fake: typeof fetch = async (url) =>
			String(url).includes("linked-wallets")
				? new Response("{}", { status: 409 })
				: new Response(JSON.stringify({ order: { orderId: "o" }, clientSecret: "c" }), { status: 200 });
		assert.equal((await createOnrampOrder(cfg, input, fake)).orderId, "o");
	});

	test("provider 4xx is 'rejected' and provider 5xx / network failure is 'unavailable'; no secret leaks", async () => {
		const rejected: typeof fetch = async () => new Response('{"message":"sk_staging_secret nope"}', { status: 400 });
		const down: typeof fetch = async () => new Response("", { status: 503 });
		const broken: typeof fetch = async () => {
			throw new Error("ECONNRESET sk_staging_secret");
		};
		for (const [f, kind] of [
			[rejected, "rejected"],
			[down, "unavailable"],
			[broken, "unavailable"],
		] as const) {
			const err = await createOnrampOrder(cfg, input, f).catch((e) => e);
			assert.ok(err instanceof OnrampError);
			assert.equal(err.kind, kind);
			assert.ok(!err.message.includes("sk_staging_secret"));
		}
	});

	test("an unexpected success body is 'unavailable', not a crash", async () => {
		const fake: typeof fetch = async (url) =>
			String(url).includes("linked-wallets")
				? new Response("{}", { status: 200 })
				: new Response('{"ok":true}', { status: 200 });
		const err = await createOnrampOrder(cfg, input, fake).catch((e) => e);
		assert.ok(err instanceof OnrampError);
		assert.equal(err.kind, "unavailable");
	});
});

describe("POST /v1/onramp/orders", () => {
	let s: TestServer;
	let n = 0;
	const ip = () => `10.9.${Math.floor(++n / 250)}.${n % 250}`;

	beforeAll(async () => {
		process.env.FP_SETTLEMENT = "mock";
		process.env.FP_SOLANA_CLUSTER = "devnet";
		process.env.FP_SOLANA_USDC_MINT = mint;
		process.env.FP_SOLANA_USDC_DECIMALS = "7";
		delete process.env.FP_SOLANA_PUBLIC_RPC_URL;
		delete process.env.CROSSMINT_SERVER_KEY;
		delete process.env.CROSSMINT_ENV;
		resetSolanaRuntimeConfigCache();
		s = await startTestServer({ auth: true });
	}, 120_000);
	afterAll(async () => {
		resetSolanaRuntimeConfigCache();
		try {
			await s?.stop();
		} catch (cause) {
			if (!/EBUSY|resource busy|locked/i.test(String(cause))) throw cause;
		}
	});

	async function cookieFor(email: string): Promise<string> {
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

	const post = (cookie: string | null, body: unknown) =>
		fetch(`${s.base}/v1/onramp/orders`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: s.origin, ...(cookie ? { cookie } : {}) },
			body: JSON.stringify(body),
		});

	test("requires a customer session", async () => {
		const res = await post(null, { walletAddress: wallet, amountUsd: "5" });
		assert.equal(res.status, 401);
	});

	test("validates the body strictly (address, whole USD between 5 and 100, no extras)", async () => {
		const cookie = await cookieFor("onramp-validate@example.com");
		for (const bad of [
			{ walletAddress: "nope", amountUsd: "5" },
			{ walletAddress: wallet, amountUsd: "4" },
			{ walletAddress: wallet, amountUsd: "101" },
			{ walletAddress: wallet, amountUsd: "5.5" },
			{ walletAddress: wallet, amountUsd: "5", extra: 1 },
			{ walletAddress: wallet },
		]) {
			const res = await post(cookie, bad);
			assert.equal(res.status, 400, JSON.stringify(bad));
		}
	});

	test("is 422 onramp_unavailable when card payments are not configured (no key, or not staging)", async () => {
		const cookie = await cookieFor("onramp-off@example.com");
		const res = await post(cookie, { walletAddress: wallet, amountUsd: "5" });
		assert.equal(res.status, 422);
		assert.equal(((await res.json()) as { code: string }).code, "onramp_unavailable");
	});
});
