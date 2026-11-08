import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
	BlindPayAdapter,
	JupiterError,
	type FetchLike,
	type JupiterExactOutQuote,
} from "@flexipay/adapters-live";
import type { Provider } from "@flexipay/domain";
import { resetSolanaRuntimeConfigCache } from "../src/solana/runtime-config.ts";
import { setSwapDepsForTests, type SwapDeps } from "../src/solana/swap.ts";
import { auth, startTestServer, type TestServer } from "./helpers.ts";

// CCR-49: Jupiter swap (tGBP → USDC) in the sender's wallet before a sender-wallet payout.

const TGBP = "2zMqyX4AYCk6mgy5UZ2S7zUaLxwERhK5WjqDzkPPbSpW";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const ROW: Provider = {
	id: "blindpay_sandbox",
	kind: "bank",
	countries: ["BR"],
	currencies: ["USDC", "BRL"],
	endpointTypes: ["bank_account"],
	legKinds: ["convert", "payout"],
	fee: { fixed: { amount: "0", currency: "USDC" }, bps: 0 },
	fxSpreadBps: 0,
	estimatedTimeSeconds: 600,
	limits: null,
	simulated: true,
	placeholder: false,
	implementation: "blindpay",
};

const blindpayFetch: FetchLike = async (url, init) => {
	const path = new URL(url).pathname;
	const reply = (status: number, json: unknown) => ({
		status,
		text: async () => JSON.stringify(json),
	});
	if (path === "/v1/instances/in_test") return reply(200, { type: "development" });
	if (path.endsWith("/customers/re_sender")) {
		return reply(200, { id: "re_sender", kyc_status: "approved" });
	}
	if (path.endsWith("/quotes/fx")) {
		return reply(200, { result_amount: 50000, blindpay_quotation: 5 });
	}
	return reply(500, { message: `unexpected ${init.method} ${path}` });
};

const MAINNET_ENV: Record<string, string> = {
	FP_SOLANA_CLUSTER: "mainnet-beta",
	FP_LIVE_MONEY: "1",
	FP_SOLANA_USDC_MINT: USDC,
	FP_SOLANA_USDC_DECIMALS: "6",
	FP_SOLANA_TGBP_MINT: TGBP,
	FP_SOLANA_TGBP_DECIMALS: "9",
};

function quoteOf(amount: bigint, over: Partial<JupiterExactOutQuote> = {}): JupiterExactOutQuote {
	const inAmount = (amount * 747n).toString(); // ~0.747 tGBP (9 dp) per USDC (6 dp) unit
	return {
		inputMint: TGBP,
		outputMint: USDC,
		inAmount,
		outAmount: amount.toString(),
		maxInAmount: ((BigInt(inAmount) * 1005n) / 1000n).toString(),
		slippageBps: 50,
		priceImpact: 0.0001,
		route: ["Whirlpool"],
		raw: {},
		...over,
	};
}

interface FakeState {
	balances: Record<string, bigint>;
	status: "confirmed" | "pending" | "failed";
	quoteError?: JupiterError;
	quote?: (amount: bigint) => JupiterExactOutQuote;
	asked: bigint[];
	swaps: string[];
}

function fakeDeps(state: FakeState): SwapDeps {
	return {
		rpc: {
			tokenBalance: async (_owner, mint) => state.balances[mint] ?? 0n,
			signatureStatus: async () => state.status,
		},
		jupiter: {
			quoteExactOut: async ({ amount, inputMint, outputMint }) => {
				expect(inputMint).toBe(TGBP);
				expect(outputMint).toBe(USDC);
				state.asked.push(amount);
				if (state.quoteError) throw state.quoteError;
				return (state.quote ?? quoteOf)(amount);
			},
			swapTransaction: async ({ userPublicKey }) => {
				state.swaps.push(userPublicKey);
				return { transaction: "AQIDBA==", lastValidBlockHeight: 7 };
			},
		},
	};
}

describe("CCR-49 Jupiter swap", { timeout: 60_000 }, () => {
	let s: TestServer;
	let key = "";
	let paymentId = "";
	const owner = Keypair.generate().publicKey.toBase58();
	const saved: Record<string, string | undefined> = {};
	let state: FakeState;

	async function post(path: string, body: unknown) {
		const res = await fetch(`${s.base}${path}`, {
			method: "POST",
			headers: auth(key, { "idempotency-key": `i-${Math.random()}` }),
			body: JSON.stringify(body),
		});
		const text = await res.text();
		return { status: res.status, json: text ? JSON.parse(text) : null };
	}

	function mainnet(on: boolean) {
		for (const [k, v] of Object.entries(MAINNET_ENV)) {
			if (on) {
				saved[k] = process.env[k];
				process.env[k] = v;
			} else if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
		resetSolanaRuntimeConfigCache();
	}

	beforeAll(async () => {
		s = await startTestServer();
		const org = await s.newOrg("Swap sender");
		key = org.key;
		await s.db.organization.update({
			where: { id: org.orgId },
			data: {
				kind: "individual",
				blindpayCustomerId: "re_sender",
				blindpayKycStatus: "approved",
				blindpayTosId: "to_test",
			},
		});
		const adapter = new BlindPayAdapter(ROW, {
			apiKey: "bp_test",
			instanceId: "in_test",
			sandbox: null,
			liveApproved: false,
			fetch: blindpayFetch,
		});
		const original = s.runtime.getProvider;
		s.runtime.getProvider = (id) => (id === "blindpay_sandbox" ? adapter : original(id));

		const quoted = await post("/v1/quotes", {
			source: { type: "bank_account", currency: "USD", country: "US" },
			destination: {
				type: "bank_account",
				currency: "BRL",
				country: "BR",
				recipientKind: "individual",
			},
			amount: { side: "send", value: { amount: "10000", currency: "USD" } },
			policy: "cheapest",
			settleMode: "sender_wallet_blindpay",
			payout: { details: { pixKey: "worker@example.test" } },
		});
		expect(quoted.status, JSON.stringify(quoted.json)).toBe(201);
		const recipient = await post("/v1/recipients", {
			name: "Worker B",
			kind: "individual",
			country: "BR",
		});
		const endpoint = await post("/v1/endpoints", {
			recipientId: recipient.json.id,
			type: "bank_account",
			country: "BR",
			currency: "BRL",
			network: null,
			details: { pixKey: "worker-b@example.test", accountNumber: "1234" },
			simulated: true,
		});
		expect(endpoint.status, JSON.stringify(endpoint.json)).toBe(201);
		const payment = await post("/v1/payments", {
			quoteId: quoted.json.id,
			recipientId: recipient.json.id,
			endpointId: endpoint.json.id,
			delivery: "direct",
			profile: "one_off",
		});
		expect(payment.status, JSON.stringify(payment.json)).toBe(201);
		paymentId = payment.json.id;
	});

	afterEach(() => {
		setSwapDepsForTests(null);
		mainnet(false);
	});

	afterAll(async () => {
		await s?.stop();
	});

	function arm(over: Partial<FakeState> = {}) {
		state = { balances: {}, status: "confirmed", asked: [], swaps: [], ...over };
		setSwapDepsForTests(fakeDeps(state));
	}

	it("is off on devnet: config lists no swap asset and the route is 409", async () => {
		arm();
		const cfg = await (await fetch(`${s.base}/v1/solana/config`)).json();
		expect(cfg.swapInputAssets).toEqual([]);
		const res = await post(`/v1/payments/${paymentId}/solana-swap`, {
			walletAddress: owner,
			inputAsset: "TGBP",
		});
		expect(res.status).toBe(409);
		expect(res.json.code).toBe("swap_unavailable");
		expect(state.asked).toEqual([]);
	});

	it("offers tGBP on mainnet and honours the FP_JUPITER_SWAP=0 switch", async () => {
		mainnet(true);
		const cfg = await (await fetch(`${s.base}/v1/solana/config`)).json();
		expect(cfg.swapInputAssets).toEqual(["TGBP"]);
		process.env.FP_JUPITER_SWAP = "0";
		try {
			const off = await (await fetch(`${s.base}/v1/solana/config`)).json();
			expect(off.swapInputAssets).toEqual([]);
		} finally {
			delete process.env.FP_JUPITER_SWAP;
		}
	});

	it("skips the swap when the wallet already holds the payout USDC", async () => {
		mainnet(true);
		arm({ balances: { [USDC]: 10_000_000_000n } });
		const res = await post(`/v1/payments/${paymentId}/solana-swap`, {
			walletAddress: owner,
			inputAsset: "TGBP",
		});
		expect(res.status, JSON.stringify(res.json)).toBe(200);
		expect(res.json.status).toBe("not_needed");
		expect(BigInt(res.json.requiredAmount)).toBeGreaterThan(0n);
		expect(res.json.outputDecimals).toBe(6);
		expect(state.asked).toEqual([]);
	});

	it("quotes only the shortfall and returns the unsigned swap for the sender's wallet", async () => {
		mainnet(true);
		arm({ balances: { [USDC]: 1_000_000n, [TGBP]: 10n ** 15n } });
		const res = await post(`/v1/payments/${paymentId}/solana-swap`, {
			walletAddress: owner,
			inputAsset: "TGBP",
		});
		expect(res.status, JSON.stringify(res.json)).toBe(200);
		expect(res.json).toMatchObject({
			status: "ready",
			provider: "jupiter",
			transaction: "AQIDBA==",
			inputMint: TGBP,
			inputDecimals: 9,
			outputMint: USDC,
			heldAmount: "1000000",
			route: ["Whirlpool"],
		});
		const required = BigInt(res.json.requiredAmount);
		// $100 send: BlindPay pulls the payout leg's amount (whole cents, USDC 6 dp).
		expect(required % 10_000n).toBe(0n);
		expect(state.asked).toEqual([required - 1_000_000n]);
		expect(res.json.outputAmount).toBe((required - 1_000_000n).toString());
		expect(state.swaps).toEqual([owner]);
	});

	it("refuses a high price impact, too little tGBP, no route and a Jupiter outage", async () => {
		mainnet(true);
		const body = { walletAddress: owner, inputAsset: "TGBP" };
		arm({
			balances: { [TGBP]: 10n ** 15n },
			quote: (a) => quoteOf(a, { priceImpact: 0.02 }),
		});
		let res = await post(`/v1/payments/${paymentId}/solana-swap`, body);
		expect(res.status).toBe(422);
		expect(res.json.code).toBe("swap_price_impact");

		arm({ balances: { [TGBP]: 5n } });
		res = await post(`/v1/payments/${paymentId}/solana-swap`, body);
		expect(res.status).toBe(422);
		expect(res.json.code).toBe("insufficient_balance");
		expect(res.json.details.decimals).toBe(9);
		expect(state.swaps).toEqual([]);

		arm({ quoteError: new JupiterError("no_route", "No routes found") });
		res = await post(`/v1/payments/${paymentId}/solana-swap`, body);
		expect(res.status).toBe(422);
		expect(res.json.code).toBe("swap_no_route");

		arm({ quoteError: new JupiterError("jupiter_unavailable", "down") });
		res = await post(`/v1/payments/${paymentId}/solana-swap`, body);
		expect(res.status).toBe(502);
		expect(res.json.code).toBe("swap_unavailable");
	});

	it("rejects a bad wallet address and an unknown payment", async () => {
		mainnet(true);
		arm();
		const bad = await post(`/v1/payments/${paymentId}/solana-swap`, {
			walletAddress: "x".repeat(40),
			inputAsset: "TGBP",
		});
		expect(bad.status).toBe(400);
		const missing = await post(`/v1/payments/pay_missing/solana-swap`, {
			walletAddress: owner,
			inputAsset: "TGBP",
		});
		expect(missing.status).toBe(404);
	});

	it("confirms the swap: pending, failed, short and confirmed", async () => {
		mainnet(true);
		const sig = "5".repeat(88);
		const body = { walletAddress: owner, signature: sig };
		const path = `/v1/payments/${paymentId}/solana-swap/confirm`;

		arm({ status: "pending" });
		let res = await post(path, body);
		expect(res.status).toBe(200);
		expect(res.json.status).toBe("pending");

		arm({ status: "failed" });
		res = await post(path, body);
		expect(res.status).toBe(422);
		expect(res.json.code).toBe("swap_failed");

		arm({ status: "confirmed", balances: { [USDC]: 1n } });
		res = await post(path, body);
		expect(res.status).toBe(409);
		expect(res.json.code).toBe("swap_short");

		arm({ status: "confirmed", balances: { [USDC]: 10_000_000_000n } });
		res = await post(path, body);
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ status: "confirmed", signature: sig });
	});
});
