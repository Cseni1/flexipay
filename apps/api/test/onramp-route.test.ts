import { Keypair } from "@solana/web3.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// POST /v1/onramp/orders behind the session: configuration gates, the per-user order limit and
// how Crossmint failures map to HTTP. The Crossmint call itself is stubbed (onramp-crossmint.test.ts
// covers the HTTP exchange).

const order = vi.hoisted(() => ({
	impl: async (): Promise<{ orderId: string; clientSecret: string }> => ({ orderId: "ord_1", clientSecret: "cs_1" }),
	calls: [] as Array<{ email: string; walletAddress: string; amountUsd: string; usdcMint: string }>,
}));

vi.mock("../src/onramp/crossmint.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/onramp/crossmint.ts")>();
	return {
		...real,
		createOnrampOrder: async (_cfg: unknown, input: (typeof order.calls)[number]) => {
			order.calls.push(input);
			return order.impl();
		},
	};
});

const { OnrampError } = await import("../src/onramp/crossmint.ts");
const { resetSolanaRuntimeConfigCache } = await import("../src/solana/runtime-config.ts");
const { startTestServer } = await import("./helpers.ts");

const PASSWORD = "correct-horse-1";
const mint = Keypair.generate().publicKey.toBase58();
const wallet = Keypair.generate().publicKey.toBase58();
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	FP_SOLANA_CLUSTER: "devnet",
	FP_SOLANA_USDC_MINT: mint,
	FP_SOLANA_USDC_DECIMALS: "6",
	CROSSMINT_SERVER_KEY: "sk_staging_test",
	CROSSMINT_ENV: "staging",
};

let s: Awaited<ReturnType<typeof startTestServer>>;
let n = 0;
const ip = () => `10.11.${Math.floor(++n / 250)}.${n % 250}`;

beforeAll(async () => {
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	resetSolanaRuntimeConfigCache();
	s = await startTestServer({ auth: true });
}, 120_000);

afterAll(async () => {
	await s?.stop();
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	resetSolanaRuntimeConfigCache();
});

beforeEach(() => {
	order.calls.length = 0;
	order.impl = async () => ({ orderId: "ord_1", clientSecret: "cs_1" });
});

async function cookieFor(email: string): Promise<string> {
	const h = { "content-type": "application/json", origin: s.origin, "x-forwarded-for": ip() };
	await fetch(`${s.base}/api/auth/sign-up/email`, {
		method: "POST",
		headers: h,
		body: JSON.stringify({ email, password: PASSWORD, name: "Card" }),
	});
	const link = /(https?:\/\/\S+)/.exec(s.mail.outbox.filter((m) => m.to === email).at(-1)!.text)![1]!;
	await fetch(link.replace(s.origin, s.base), { redirect: "manual" });
	const inn = await fetch(`${s.base}/api/auth/sign-in/email`, {
		method: "POST",
		headers: { ...h, "x-forwarded-for": ip() },
		body: JSON.stringify({ email, password: PASSWORD }),
	});
	expect(inn.status).toBe(200);
	return inn.headers
		.getSetCookie()
		.map((c) => c.split(";")[0]!)
		.join("; ");
}

const post = (cookie: string, body: unknown = { walletAddress: wallet, amountUsd: "25" }) =>
	fetch(`${s.base}/v1/onramp/orders`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: s.origin, cookie },
		body: JSON.stringify(body),
	});

describe("POST /v1/onramp/orders (configured, staging)", () => {
	it("creates an order for the signed-in user's email and the chosen wallet", async () => {
		const cookie = await cookieFor("card-ok@example.com");
		const res = await post(cookie);
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({ orderId: "ord_1", clientSecret: "cs_1" });
		expect(order.calls).toEqual([{ email: "card-ok@example.com", walletAddress: wallet, amountUsd: "25", usdcMint: mint }]);
	});

	it("maps a Crossmint refusal to 422 and an outage to 502; any other error is a 500", async () => {
		const cookie = await cookieFor("card-errors@example.com");
		order.impl = async () => {
			throw new OnrampError("rejected", "The card provider did not accept this wallet.");
		};
		const rejected = await post(cookie);
		expect(rejected.status).toBe(422);
		expect((await rejected.json()).code).toBe("onramp_rejected");

		order.impl = async () => {
			throw new OnrampError("unavailable", "The card provider is unavailable.");
		};
		const down = await post(cookie);
		expect(down.status).toBe(502);
		expect((await down.json()).code).toBe("onramp_unavailable");

		const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			order.impl = async () => {
				throw new TypeError("boom");
			};
			const crash = await post(cookie);
			expect(crash.status).toBe(500);
			expect((await crash.json()).code).toBe("internal_error");
		} finally {
			quiet.mockRestore();
		}
	});

	it("limits each user to 10 orders per 10 minutes, per user", async () => {
		const busy = await cookieFor("card-busy@example.com");
		for (let i = 0; i < 10; i++) expect((await post(busy)).status).toBe(201);
		const limited = await post(busy);
		expect(limited.status).toBe(422);
		expect((await limited.json()).code).toBe("rate_limited");
		// Another user is unaffected.
		const other = await cookieFor("card-other@example.com");
		expect((await post(other)).status).toBe(201);
	});

	it("is unavailable off devnet", async () => {
		const cookie = await cookieFor("card-testnet@example.com");
		process.env.FP_SOLANA_CLUSTER = "testnet";
		resetSolanaRuntimeConfigCache();
		try {
			const res = await post(cookie);
			expect(res.status).toBe(422);
			const body = await res.json();
			expect(body.code).toBe("onramp_unavailable");
			expect(body.message).toMatch(/devnet only/);
			expect(order.calls).toEqual([]);
		} finally {
			process.env.FP_SOLANA_CLUSTER = "devnet";
			resetSolanaRuntimeConfigCache();
		}
	});

	it("is unavailable with a production-looking key, even on staging", async () => {
		const cookie = await cookieFor("card-prod@example.com");
		process.env.CROSSMINT_SERVER_KEY = "sk_production_123";
		try {
			const res = await post(cookie);
			expect(res.status).toBe(422);
			expect((await res.json()).message).toMatch(/not configured/);
		} finally {
			process.env.CROSSMINT_SERVER_KEY = ENV.CROSSMINT_SERVER_KEY;
		}
	});
});
