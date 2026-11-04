import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { Keypair } from "@solana/web3.js";
import { evaluateParsedTransfer } from "@flexipay/adapter-solana";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { auth, startTestServer } from "./helpers.ts";
import { resetSolanaRuntimeConfigCache } from "../src/solana/runtime-config.ts";
import { setSolanaVerifyForTests } from "../src/solana/verify.ts";

const recipient = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
const flexipayMinor = "10000000"; // 1 USDC @ 7 decimals

afterEach(() => {
	setSolanaVerifyForTests(null);
	resetSolanaRuntimeConfigCache();
});

async function stopApi(api: Awaited<ReturnType<typeof startTestServer>>): Promise<void> {
	try {
		await api.stop();
	} catch (cause) {
		const msg = cause instanceof Error ? cause.message : String(cause);
		// Windows often leaves the embedded Postgres data dir locked briefly.
		if (!/EBUSY|resource busy|locked/i.test(msg)) throw cause;
	}
}

async function bootstrapSolanaPayment(api: Awaited<ReturnType<typeof startTestServer>>, key: string) {
	const created = await fetch(`${api.base}/v1/recipients`, {
		method: "POST",
		headers: auth(key, { "idempotency-key": "s-rcp-" + Math.random() }),
		body: JSON.stringify({
			name: "Recv",
			kind: "individual",
			country: "PH",
		}),
	});
	assert.equal(created.status, 201);
	const rcp = (await created.json()) as { id: string };

	const quoteRes = await fetch(`${api.base}/v1/quotes`, {
		method: "POST",
		headers: auth(key, { "idempotency-key": "s-quote-" + Math.random() }),
		body: JSON.stringify({
			source: { type: "bank_account", currency: "USD", country: "US" },
			destination: {
				type: "crypto_wallet",
				currency: "USDC",
				country: "PH",
				recipientKind: "individual",
			},
			amount: {
				side: "receive",
				value: { amount: flexipayMinor, currency: "USDC" },
			},
			policy: "cheapest",
			feeMode: "PayerPays",
		}),
	});
	const quoteText = await quoteRes.text();
	assert.equal(quoteRes.status, 201, quoteText);
	const quote = JSON.parse(quoteText) as { id: string };

	const paymentRes = await fetch(`${api.base}/v1/payments`, {
		method: "POST",
		headers: auth(key, { "idempotency-key": "s-pay-" + Math.random() }),
		body: JSON.stringify({
			quoteId: quote.id,
			recipientId: rcp.id,
			delivery: "claim_link",
			profile: "one_off",
		}),
	});
	const paymentText = await paymentRes.text();
	assert.equal(paymentRes.status, 201, paymentText);
	const payment = JSON.parse(paymentText) as {
		id: string;
		claimLink: { url: string };
	};

	const fundRes = await fetch(`${api.base}/v1/payments/${payment.id}/fund`, {
		method: "POST",
		headers: auth(key, { "idempotency-key": "s-fund-" + Math.random() }),
		body: "{}",
	});
	const fundText = await fundRes.text();
	assert.equal(fundRes.status, 200, fundText);

	const token = payment.claimLink.url.split("/").pop()!;
	const accept = await fetch(`${api.base}/v1/claims/${token}/accept`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"idempotency-key": "s-accept-" + Math.random(),
		},
		body: JSON.stringify({
			endpoint: {
				type: "crypto_wallet",
				country: "",
				currency: "USDC",
				network: "solana",
				details: { address: recipient },
				simulated: true,
			},
		}),
	});
	const acceptText = await accept.text();
	assert.equal(accept.status, 200, acceptText);
	return { payment, rcp, token };
}

describe("CCR-24 Solana claim + confirm", () => {
	test("accept leaves processing; confirm pays only after verify", async () => {
		process.env.FP_SETTLEMENT = "mock";
		process.env.FP_SOLANA_CLUSTER = "devnet";
		process.env.FP_SOLANA_USDC_MINT = mint;
		process.env.FP_SOLANA_USDC_DECIMALS = "7";
		delete process.env.FP_SOLANA_PUBLIC_RPC_URL;
		resetSolanaRuntimeConfigCache();

		const pendingSig = "pending-sig-" + "p".repeat(48);
		const badSig = "bad-sig-" + "b".repeat(52);
		const okSig = "ok-sig-" + "1".repeat(52);
		const otherSig = "other-sig-" + "2".repeat(48);

		setSolanaVerifyForTests(async (_rpc, input) => {
			if (input.signature === pendingSig) {
				return { ok: false, reason: "not_found", message: "not yet" };
			}
			if (input.signature === badSig) {
				return { ok: false, reason: "amount_too_low", message: "too low" };
			}
			if (!input.reference) {
				return { ok: false, reason: "missing_reference", message: "no ref" };
			}
			return {
				ok: true,
				signature: input.signature,
				amountMinor: input.amountMinor,
				mint: input.mint,
				recipientOwner: input.recipientOwner,
				slot: 99,
				blockTime: Math.floor(Date.now() / 1000),
			};
		});

		const api = await startTestServer();
		const { key } = await api.newOrg("Solana Confirm Org");
		try {
			const { payment } = await bootstrapSolanaPayment(api, key);

			const configRes = await fetch(`${api.base}/v1/solana/config`);
			assert.equal(configRes.status, 200);
			const config = (await configRes.json()) as {
				publicRpcUrl: string | null;
				assets: { asset: string; mint: string; decimals: number }[];
			};
			assert.equal(config.publicRpcUrl, null);
			// CCR-26: USDC behaviour unchanged; TGBP absent unless FP_SOLANA_TGBP_MINT is set.
			assert.deepEqual(config.assets, [{ asset: "USDC", mint, decimals: 7 }]);

			const intentRes = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/intent`,
				{ headers: auth(key) },
			);
			const intentText = await intentRes.text();
			assert.equal(intentRes.status, 200, intentText);
			const intent = JSON.parse(intentText) as {
				asset: string;
				mint: string;
				usdcMint: string;
				recipient: string;
				reference: string;
				intentIssuedAt: string;
			};
			assert.equal(intent.recipient, recipient);
			assert.equal(intent.asset, "USDC");
			assert.equal(intent.mint, mint);
			assert.equal(intent.usdcMint, mint);
			assert.ok(intent.reference.length >= 32);
			assert.ok(Date.parse(intent.intentIssuedAt) > 0);

			const pending = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/confirm`,
				{
					method: "POST",
					headers: auth(key, { "idempotency-key": "s-conf-pending" }),
					body: JSON.stringify({ signature: pendingSig }),
				},
			);
			assert.equal(pending.status, 202);

			const rejected = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/confirm`,
				{
					method: "POST",
					headers: auth(key, { "idempotency-key": "s-conf-bad" }),
					body: JSON.stringify({ signature: badSig }),
				},
			);
			assert.equal(rejected.status, 422);

			const confirm = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/confirm`,
				{
					method: "POST",
					headers: auth(key, { "idempotency-key": "s-conf-ok" }),
					body: JSON.stringify({ signature: okSig }),
				},
			);
			const confirmText = await confirm.text();
			assert.equal(confirm.status, 200, confirmText);
			const body = JSON.parse(confirmText) as {
				paymentStatus: string;
				signature: string;
			};
			assert.equal(body.paymentStatus, "paid");
			assert.equal(body.signature, okSig);

			const replay = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/confirm`,
				{
					method: "POST",
					headers: auth(key, { "idempotency-key": "s-conf-replay" }),
					body: JSON.stringify({ signature: okSig }),
				},
			);
			assert.equal(replay.status, 200);

			const conflict = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/confirm`,
				{
					method: "POST",
					headers: auth(key, { "idempotency-key": "s-conf-conflict" }),
					body: JSON.stringify({ signature: otherSig }),
				},
			);
			assert.equal(conflict.status, 409);

			const settle = await api.db.leg.findFirst({
				where: { paymentId: payment.id, kind: "settle" },
			});
			assert.equal(settle?.rail, "solana_usdc");
			assert.equal(settle?.lockTxRef, null);
			assert.equal(settle?.externalRef, null);
		} finally {
			await stopApi(api);
		}
	}, 120_000);

	test("F5: intent/confirm use claim-bound endpoint, not a later endpoint", async () => {
		process.env.FP_SETTLEMENT = "mock";
		process.env.FP_SOLANA_CLUSTER = "devnet";
		process.env.FP_SOLANA_USDC_MINT = mint;
		process.env.FP_SOLANA_USDC_DECIMALS = "7";
		resetSolanaRuntimeConfigCache();

		setSolanaVerifyForTests(async (_rpc, input) => ({
			ok: true,
			signature: input.signature,
			amountMinor: input.amountMinor,
			mint: input.mint,
			recipientOwner: input.recipientOwner,
			slot: 1,
			blockTime: Math.floor(Date.now() / 1000),
		}));

		const api = await startTestServer();
		const { key } = await api.newOrg("Solana F5 Org");
		try {
			const { payment, rcp } = await bootstrapSolanaPayment(api, key);
			const decoy = Keypair.generate().publicKey.toBase58();
			const ep = await fetch(`${api.base}/v1/endpoints`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "s-ep-decoy" }),
				body: JSON.stringify({
					recipientId: rcp.id,
					type: "crypto_wallet",
					country: "",
					currency: "USDC",
					network: "solana",
					details: { address: decoy },
					simulated: true,
				}),
			});
			assert.equal(ep.status, 201, await ep.text());

			const intentRes = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/intent`,
				{ headers: auth(key) },
			);
			const intent = (await intentRes.json()) as { recipient: string };
			assert.equal(intent.recipient, recipient);
			assert.notEqual(intent.recipient, decoy);
		} finally {
			await stopApi(api);
		}
	}, 120_000);

	test("F8: confirm refuses before RPC when claim not accepted", async () => {
		process.env.FP_SETTLEMENT = "mock";
		process.env.FP_SOLANA_CLUSTER = "devnet";
		process.env.FP_SOLANA_USDC_MINT = mint;
		process.env.FP_SOLANA_USDC_DECIMALS = "7";
		resetSolanaRuntimeConfigCache();

		let verifyCalls = 0;
		setSolanaVerifyForTests(async () => {
			verifyCalls += 1;
			return { ok: false, reason: "not_found", message: "should not run" };
		});

		const api = await startTestServer();
		const { key } = await api.newOrg("Solana F8 Org");
		try {
			const created = await fetch(`${api.base}/v1/recipients`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "f8-rcp" }),
				body: JSON.stringify({
					name: "Recv",
					kind: "individual",
					country: "PH",
				}),
			});
			const rcp = (await created.json()) as { id: string };
			const quoteRes = await fetch(`${api.base}/v1/quotes`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "f8-quote" }),
				body: JSON.stringify({
					source: { type: "bank_account", currency: "USD", country: "US" },
					destination: {
						type: "crypto_wallet",
						currency: "USDC",
						country: "PH",
						recipientKind: "individual",
					},
					amount: {
						side: "receive",
						value: { amount: flexipayMinor, currency: "USDC" },
					},
					policy: "cheapest",
					feeMode: "PayerPays",
				}),
			});
			const quote = (await quoteRes.json()) as { id: string };
			const paymentRes = await fetch(`${api.base}/v1/payments`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "f8-pay" }),
				body: JSON.stringify({
					quoteId: quote.id,
					recipientId: rcp.id,
					delivery: "claim_link",
					profile: "one_off",
				}),
			});
			const payment = (await paymentRes.json()) as { id: string };
			await fetch(`${api.base}/v1/payments/${payment.id}/fund`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "f8-fund" }),
				body: "{}",
			});

			const confirm = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/confirm`,
				{
					method: "POST",
					headers: auth(key, { "idempotency-key": "f8-conf" }),
					body: JSON.stringify({ signature: "f8-sig-" + "x".repeat(52) }),
				},
			);
			assert.equal(confirm.status, 409);
			assert.equal(verifyCalls, 0);
		} finally {
			await stopApi(api);
		}
	}, 120_000);

	test("F4: same signature cannot pay a second payment", async () => {
		process.env.FP_SETTLEMENT = "mock";
		process.env.FP_SOLANA_CLUSTER = "devnet";
		process.env.FP_SOLANA_USDC_MINT = mint;
		process.env.FP_SOLANA_USDC_DECIMALS = "7";
		resetSolanaRuntimeConfigCache();

		const sharedSig = "shared-sig-" + "s".repeat(48);
		setSolanaVerifyForTests(async (_rpc, input) => ({
			ok: true,
			signature: input.signature,
			amountMinor: input.amountMinor,
			mint: input.mint,
			recipientOwner: input.recipientOwner,
			slot: 2,
			blockTime: Math.floor(Date.now() / 1000),
		}));

		const api = await startTestServer();
		const { key } = await api.newOrg("Solana F4 Org");
		try {
			const first = await bootstrapSolanaPayment(api, key);
			const ok1 = await fetch(
				`${api.base}/v1/payments/${first.payment.id}/solana/confirm`,
				{
					method: "POST",
					headers: auth(key, { "idempotency-key": "f4-conf-1" }),
					body: JSON.stringify({ signature: sharedSig }),
				},
			);
			assert.equal(ok1.status, 200, await ok1.text());

			const second = await bootstrapSolanaPayment(api, key);
			const ok2 = await fetch(
				`${api.base}/v1/payments/${second.payment.id}/solana/confirm`,
				{
					method: "POST",
					headers: auth(key, { "idempotency-key": "f4-conf-2" }),
					body: JSON.stringify({ signature: sharedSig }),
				},
			);
			assert.equal(ok2.status, 409);
			const body = (await ok2.json()) as { code: string };
			assert.equal(body.code, "signature_reused");
		} finally {
			await stopApi(api);
		}
	}, 180_000);

	test("F4 concurrent: racing confirms with the same signature pay at most one payment", async () => {
		process.env.FP_SETTLEMENT = "mock";
		process.env.FP_SOLANA_CLUSTER = "devnet";
		process.env.FP_SOLANA_USDC_MINT = mint;
		process.env.FP_SOLANA_USDC_DECIMALS = "7";
		resetSolanaRuntimeConfigCache();

		const raceSig = "race-sig-" + "r".repeat(52);
		setSolanaVerifyForTests(async (_rpc, input) => ({
			ok: true,
			signature: input.signature,
			amountMinor: input.amountMinor,
			mint: input.mint,
			recipientOwner: input.recipientOwner,
			slot: 3,
			blockTime: Math.floor(Date.now() / 1000),
		}));

		const api = await startTestServer();
		const { key } = await api.newOrg("Solana F4 Race Org");
		try {
			const a = await bootstrapSolanaPayment(api, key);
			const b = await bootstrapSolanaPayment(api, key);
			const [ra, rb] = await Promise.all([
				fetch(`${api.base}/v1/payments/${a.payment.id}/solana/confirm`, {
					method: "POST",
					headers: auth(key, { "idempotency-key": "f4-race-a" }),
					body: JSON.stringify({ signature: raceSig }),
				}),
				fetch(`${api.base}/v1/payments/${b.payment.id}/solana/confirm`, {
					method: "POST",
					headers: auth(key, { "idempotency-key": "f4-race-b" }),
					body: JSON.stringify({ signature: raceSig }),
				}),
			]);
			const statuses = [ra.status, rb.status].sort();
			assert.deepEqual(statuses, [200, 409]);
			const paidCount = await api.db.leg.count({
				where: { releaseTxRef: raceSig, status: "succeeded" },
			});
			assert.equal(paidCount, 1);
		} finally {
			await stopApi(api);
		}
	}, 180_000);

	test("F6: config never echoes FP_SOLANA_RPC_URL when public RPC unset", async () => {
		process.env.FP_SETTLEMENT = "mock";
		process.env.FP_SOLANA_CLUSTER = "devnet";
		process.env.FP_SOLANA_USDC_MINT = mint;
		process.env.FP_SOLANA_USDC_DECIMALS = "7";
		process.env.FP_SOLANA_RPC_URL =
			"https://secret-helius.example/rpc?api-key=DO_NOT_LEAK";
		delete process.env.FP_SOLANA_PUBLIC_RPC_URL;
		resetSolanaRuntimeConfigCache();

		const api = await startTestServer();
		try {
			const res = await fetch(`${api.base}/v1/solana/config`);
			assert.equal(res.status, 200);
			const body = (await res.json()) as { publicRpcUrl: string | null };
			assert.equal(body.publicRpcUrl, null);
			const raw = JSON.stringify(body);
			assert.equal(raw.includes("DO_NOT_LEAK"), false);
			assert.equal(raw.includes("secret-helius"), false);
		} finally {
			delete process.env.FP_SOLANA_RPC_URL;
			resetSolanaRuntimeConfigCache();
			await stopApi(api);
		}
	}, 60_000);

	test("F9: Solana accept clears vault lock refs (independent of Stellar settle)", async () => {
		process.env.FP_SETTLEMENT = "mock";
		process.env.FP_SOLANA_CLUSTER = "devnet";
		process.env.FP_SOLANA_USDC_MINT = mint;
		process.env.FP_SOLANA_USDC_DECIMALS = "7";
		resetSolanaRuntimeConfigCache();

		const api = await startTestServer();
		const { key } = await api.newOrg("Solana F9 Org");
		try {
			const { payment } = await bootstrapSolanaPayment(api, key);
			const settle = await api.db.leg.findFirstOrThrow({
				where: { paymentId: payment.id, kind: "settle" },
			});
			assert.equal(settle.rail, "solana_usdc");
			assert.equal(settle.lockTxRef, null);
			assert.equal(settle.externalRef, null);
			assert.equal(settle.fundNetwork, "solana");
			assert.equal(settle.status, "processing");
			assert.equal(settle.releaseTxRef, null);
		} finally {
			await stopApi(api);
		}
	}, 120_000);
});

describe("Solana USDC decimals: intent uses quoted amount; unrepresentable → 422", () => {
	test("send 100 floors to 9851480 and intent returns that Solana minor amount", async () => {
		process.env.FP_SETTLEMENT = "mock";
		process.env.FP_SOLANA_CLUSTER = "devnet";
		process.env.FP_SOLANA_USDC_MINT = mint;
		process.env.FP_SOLANA_USDC_DECIMALS = "6";
		delete process.env.FP_SOLANA_PUBLIC_RPC_URL;
		resetSolanaRuntimeConfigCache();

		const api = await startTestServer();
		const { key } = await api.newOrg("Solana Decimals Floor Org");
		try {
			const quoteRes = await fetch(`${api.base}/v1/quotes`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "dec-q-100" }),
				body: JSON.stringify({
					source: { type: "bank_account", currency: "USD", country: "US" },
					destination: {
						type: "crypto_wallet",
						currency: "USDC",
						country: "PH",
						recipientKind: "individual",
					},
					amount: {
						side: "send",
						value: { amount: "100", currency: "USD" },
					},
					policy: "cheapest",
					feeMode: "PayerPays",
				}),
			});
			const quoteText = await quoteRes.text();
			assert.equal(quoteRes.status, 201, quoteText);
			const quote = JSON.parse(quoteText) as {
				id: string;
				expectedReceive: { amount: string; currency: string };
				route: Array<{ kind: string; rail: string; amountOut: { amount: string } }>;
			};
			assert.equal(quote.expectedReceive.amount, "9851480");
			const settle = quote.route.find((l) => l.kind === "settle");
			assert.equal(settle?.rail, "stellar_usdc");
			assert.equal(settle?.amountOut.amount, "9851480");

			const created = await fetch(`${api.base}/v1/recipients`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "dec-rcp-100" }),
				body: JSON.stringify({
					name: "Recv",
					kind: "individual",
					country: "PH",
				}),
			});
			assert.equal(created.status, 201);
			const rcp = (await created.json()) as { id: string };

			const paymentRes = await fetch(`${api.base}/v1/payments`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "dec-pay-100" }),
				body: JSON.stringify({
					quoteId: quote.id,
					recipientId: rcp.id,
					delivery: "claim_link",
					profile: "one_off",
				}),
			});
			assert.equal(paymentRes.status, 201);
			const payment = (await paymentRes.json()) as {
				id: string;
				claimLink: { url: string };
			};

			const fundRes = await fetch(`${api.base}/v1/payments/${payment.id}/fund`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "dec-fund-100" }),
				body: "{}",
			});
			assert.equal(fundRes.status, 200);

			const token = payment.claimLink.url.split("/").pop()!;
			const accept = await fetch(`${api.base}/v1/claims/${token}/accept`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "dec-accept-100",
				},
				body: JSON.stringify({
					endpoint: {
						type: "crypto_wallet",
						country: "",
						currency: "USDC",
						network: "solana",
						details: { address: recipient },
						simulated: true,
					},
				}),
			});
			assert.equal(accept.status, 200);

			const intentRes = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/intent`,
				{ headers: auth(key) },
			);
			const intentText = await intentRes.text();
			assert.equal(intentRes.status, 200, intentText);
			const intent = JSON.parse(intentText) as { amount: string; usdcDecimals: number };
			assert.equal(intent.usdcDecimals, 6);
			assert.equal(intent.amount, "985148"); // 9851480 / 10
		} finally {
			await stopApi(api);
		}
	}, 180_000);

	test("send 101 keeps 9950000 and intent succeeds", async () => {
		process.env.FP_SETTLEMENT = "mock";
		process.env.FP_SOLANA_CLUSTER = "devnet";
		process.env.FP_SOLANA_USDC_MINT = mint;
		process.env.FP_SOLANA_USDC_DECIMALS = "6";
		delete process.env.FP_SOLANA_PUBLIC_RPC_URL;
		resetSolanaRuntimeConfigCache();

		const api = await startTestServer();
		const { key } = await api.newOrg("Solana Decimals Pass Org");
		try {
			const quoteRes = await fetch(`${api.base}/v1/quotes`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "dec-q-101" }),
				body: JSON.stringify({
					source: { type: "bank_account", currency: "USD", country: "US" },
					destination: {
						type: "crypto_wallet",
						currency: "USDC",
						country: "PH",
						recipientKind: "individual",
					},
					amount: {
						side: "send",
						value: { amount: "101", currency: "USD" },
					},
					policy: "cheapest",
					feeMode: "PayerPays",
				}),
			});
			const quoteText = await quoteRes.text();
			assert.equal(quoteRes.status, 201, quoteText);
			const quote = JSON.parse(quoteText) as {
				id: string;
				expectedReceive: { amount: string };
			};
			assert.equal(quote.expectedReceive.amount, "9950000");

			const created = await fetch(`${api.base}/v1/recipients`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "dec-rcp-101" }),
				body: JSON.stringify({
					name: "Recv",
					kind: "individual",
					country: "PH",
				}),
			});
			assert.equal(created.status, 201);
			const rcp = (await created.json()) as { id: string };

			const paymentRes = await fetch(`${api.base}/v1/payments`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "dec-pay-101" }),
				body: JSON.stringify({
					quoteId: quote.id,
					recipientId: rcp.id,
					delivery: "claim_link",
					profile: "one_off",
				}),
			});
			assert.equal(paymentRes.status, 201);
			const payment = (await paymentRes.json()) as {
				id: string;
				claimLink: { url: string };
			};

			assert.equal(
				(
					await fetch(`${api.base}/v1/payments/${payment.id}/fund`, {
						method: "POST",
						headers: auth(key, { "idempotency-key": "dec-fund-101" }),
						body: "{}",
					})
				).status,
				200,
			);

			const token = payment.claimLink.url.split("/").pop()!;
			assert.equal(
				(
					await fetch(`${api.base}/v1/claims/${token}/accept`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							"idempotency-key": "dec-accept-101",
						},
						body: JSON.stringify({
							endpoint: {
								type: "crypto_wallet",
								country: "",
								currency: "USDC",
								network: "solana",
								details: { address: recipient },
								simulated: true,
							},
						}),
					})
				).status,
				200,
			);

			const intentRes = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/intent`,
				{ headers: auth(key) },
			);
			const intentText = await intentRes.text();
			assert.equal(intentRes.status, 200, intentText);
			const intent = JSON.parse(intentText) as { amount: string };
			assert.equal(intent.amount, "995000"); // 9950000 / 10
		} finally {
			await stopApi(api);
		}
	}, 180_000);

	test("unrepresentable expectedReceive on intent returns 422 amount_not_representable", async () => {
		process.env.FP_SETTLEMENT = "mock";
		process.env.FP_SOLANA_CLUSTER = "devnet";
		process.env.FP_SOLANA_USDC_MINT = mint;
		process.env.FP_SOLANA_USDC_DECIMALS = "6";
		delete process.env.FP_SOLANA_PUBLIC_RPC_URL;
		resetSolanaRuntimeConfigCache();

		const api = await startTestServer();
		const { key } = await api.newOrg("Solana Decimals 422 Org");
		try {
			const { payment } = await bootstrapSolanaPayment(api, key);
			// Safety-net path: force a stale unrepresentable FlexiPay minor amount.
			await api.db.quote.updateMany({
				where: { payments: { some: { id: payment.id } } },
				data: { expectedReceive: "9851485" },
			});

			const intentRes = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/intent`,
				{ headers: auth(key) },
			);
			const intentText = await intentRes.text();
			assert.equal(intentRes.status, 422, intentText);
			const body = JSON.parse(intentText) as { code: string; message: string };
			assert.equal(body.code, "amount_not_representable");
			assert.match(body.message, /not representable/i);
			assert.notEqual(body.code, "internal_error");
		} finally {
			await stopApi(api);
		}
	}, 180_000);
});

describe("Lane B adapter negative fixtures (wired through evaluateParsedTransfer)", () => {
	test("non-USDC balance delta is wrong_mint", () => {
		const otherMint = Keypair.generate().publicKey.toBase58();
		const owner = Keypair.generate().publicKey.toBase58();
		const usdc = Keypair.generate().publicKey.toBase58();
		const tx = {
			slot: 1,
			blockTime: 100,
			transaction: { message: { accountKeys: [owner], instructions: [] } },
			meta: {
				err: null,
				preTokenBalances: [],
				postTokenBalances: [
					{
						accountIndex: 0,
						mint: otherMint,
						owner,
						uiTokenAmount: { amount: "5", decimals: 6 },
					},
				],
			},
		} as unknown as ParsedTransactionWithMeta;
		const result = evaluateParsedTransfer(tx, {
			signature: "x",
			mint: usdc,
			recipientOwner: owner,
			amountMinor: 1n,
			usdcDecimals: 6,
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "wrong_mint");
	});
});
