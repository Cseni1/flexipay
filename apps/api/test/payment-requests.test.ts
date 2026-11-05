import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { Keypair } from "@solana/web3.js";
import { auth, startTestServer } from "./helpers.ts";
import { resetSolanaRuntimeConfigCache } from "../src/solana/runtime-config.ts";
import { setSolanaVerifyForTests } from "../src/solana/verify.ts";
import {
	setReferenceLookupForTests,
	setReferenceThrottleMsForTests,
} from "../src/solana/reference.ts";

// CCR-27: payment requests (till QR). No real network: the reference look-up and the
// on-chain verification are both stubbed.
const merchant = Keypair.generate().publicKey.toBase58();
const usdcMint = Keypair.generate().publicKey.toBase58();
const tgbpMint = Keypair.generate().publicKey.toBase58();

type Api = Awaited<ReturnType<typeof startTestServer>>;

afterEach(() => {
	setSolanaVerifyForTests(null);
	setReferenceLookupForTests(null);
	setReferenceThrottleMsForTests(null);
	resetSolanaRuntimeConfigCache();
	delete process.env.FP_SOLANA_TGBP_MINT;
	delete process.env.FP_SOLANA_TGBP_DECIMALS;
});

function setEnv(withTgbp: boolean): void {
	process.env.FP_SETTLEMENT = "mock";
	process.env.FP_SOLANA_CLUSTER = "devnet";
	process.env.FP_SOLANA_USDC_MINT = usdcMint;
	process.env.FP_SOLANA_USDC_DECIMALS = "6";
	if (withTgbp) {
		process.env.FP_SOLANA_TGBP_MINT = tgbpMint;
		process.env.FP_SOLANA_TGBP_DECIMALS = "6";
	} else {
		delete process.env.FP_SOLANA_TGBP_MINT;
		delete process.env.FP_SOLANA_TGBP_DECIMALS;
	}
	delete process.env.FP_SOLANA_PUBLIC_RPC_URL;
	resetSolanaRuntimeConfigCache();
	setReferenceThrottleMsForTests(0);
}

async function stopApi(api: Api): Promise<void> {
	try {
		await api.stop();
	} catch (cause) {
		const msg = cause instanceof Error ? cause.message : String(cause);
		if (!/EBUSY|resource busy|locked/i.test(msg)) throw cause;
	}
}

async function post(api: Api, key: string, path: string, body: unknown) {
	return fetch(`${api.base}${path}`, {
		method: "POST",
		headers: auth(key, { "idempotency-key": "pr-" + Math.random() }),
		body: JSON.stringify(body),
	});
}

async function get(api: Api, key: string, path: string) {
	return fetch(`${api.base}${path}`, { headers: auth(key) });
}

const okVerify = (input: { signature: string; mint: string; amountMinor: bigint; recipientOwner: string }) => ({
	ok: true as const,
	signature: input.signature,
	amountMinor: input.amountMinor,
	mint: input.mint,
	recipientOwner: input.recipientOwner,
	slot: 9,
	blockTime: Math.floor(Date.now() / 1000),
});

describe("CCR-27 payment requests", { timeout: 60_000 }, () => {
	test("create: shape, exact on-chain amount, Solana Pay URL, no schema/side effects on other payments", async () => {
		setEnv(true);
		const api = await startTestServer({ sandbox: true });
		const { key } = await api.newOrg("Till Org");
		try {
			const res = await post(api, key, "/v1/payment-requests", {
				amount: "1000",
				merchantWallet: merchant,
				label: "Café Nero",
			});
			const body = (await res.json()) as any;
			assert.equal(res.status, 201, JSON.stringify(body));
			assert.equal(body.status, "waiting");
			assert.deepEqual(body.amount, { amount: "100000000", currency: "TGBP" });
			assert.equal(body.merchantWallet, merchant);
			assert.equal(body.label, "Café Nero");
			assert.equal(body.signature, null);
			assert.equal(body.explorerUrl, null);
			assert.ok(new Date(body.expiresAt).getTime() > Date.now());
			const url = new URL(body.solanaPayUrl.replace("solana:", "solana://"));
			assert.equal(url.hostname, merchant.toLowerCase() === merchant ? merchant : url.hostname);
			assert.match(body.solanaPayUrl, new RegExp(`^solana:${merchant}\\?`));
			assert.equal(url.searchParams.get("amount"), "10");
			assert.equal(url.searchParams.get("spl-token"), tgbpMint);
			assert.equal(url.searchParams.get("reference"), body.reference);
			assert.equal(url.searchParams.get("label"), "Café Nero");
			assert.equal(url.searchParams.get("message"), "Pay £10.00");
			// The underlying payment is a normal payment with a TGBP settle leg awaiting the transfer.
			const pay = (await (await get(api, key, `/v1/payments/${body.id}`)).json()) as any;
			assert.equal(pay.status, "processing");
			assert.equal(pay.legs.find((l: any) => l.kind === "settle").rail, "solana_tgbp");
		} finally {
			await stopApi(api);
		}
	});

	test("the amount on-chain is exactly the requested pounds, even when the fee maths has no exact penny", async () => {
		setEnv(true);
		const verified: bigint[] = [];
		let nextSig = 0;
		setReferenceLookupForTests(async () => [`sigExact${nextSig}`]);
		setSolanaVerifyForTests(async (_rpc, input) => {
			verified.push(input.amountMinor);
			return okVerify(input);
		});
		const api = await startTestServer({ sandbox: true });
		const { key } = await api.newOrg("Exact Org");
		try {
			for (const [pence, onChain, decimal] of [
				["1000", 10_000_000n, "10"],
				["1050", 10_500_000n, "10.5"],
				["199", 1_990_000n, "1.99"],
			] as const) {
				const res = await post(api, key, "/v1/payment-requests", {
					amount: pence,
					merchantWallet: merchant,
				});
				const body = (await res.json()) as any;
				assert.equal(res.status, 201, JSON.stringify(body));
				assert.equal(
					new URL(body.solanaPayUrl.replace("solana:", "solana://")).searchParams.get("amount"),
					decimal,
				);
				nextSig += 1;
				const st = (await (await get(api, key, `/v1/payment-requests/${body.id}`)).json()) as any;
				assert.equal(st.status, "paid", JSON.stringify(st));
				assert.equal(verified.at(-1), onChain, `on-chain amount for ${pence} pence`);
			}
		} finally {
			await stopApi(api);
		}
	});

	test("422 on bad wallet; 400 on bad amount, extra field; TGBP not configured is 422 unsupported_asset", async () => {
		setEnv(true);
		const api = await startTestServer({ sandbox: true });
		const { key } = await api.newOrg("Validation Org");
		try {
			const badWallet = await post(api, key, "/v1/payment-requests", {
				amount: "1000",
				merchantWallet: "1".repeat(40),
			});
			assert.equal(badWallet.status, 422);
			assert.equal(((await badWallet.json()) as any).code, "invalid_address");
			for (const bad of [
				{ amount: "99", merchantWallet: merchant },
				{ amount: "1000001", merchantWallet: merchant },
				{ amount: "10.50", merchantWallet: merchant },
				{ amount: "0", merchantWallet: merchant },
				{ amount: "1000", merchantWallet: merchant, label: "" },
				{ amount: "1000", merchantWallet: merchant, extra: true },
				{ merchantWallet: merchant },
			]) {
				const res = await post(api, key, "/v1/payment-requests", bad);
				assert.equal(res.status, 400, JSON.stringify(bad));
			}
			const anon = await fetch(`${api.base}/v1/payment-requests`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ amount: "1000", merchantWallet: merchant }),
			});
			assert.equal(anon.status, 401);
		} finally {
			await stopApi(api);
		}
		// No tGBP mint configured.
		setEnv(false);
		const api2 = await startTestServer({ sandbox: true });
		const { key: key2 } = await api2.newOrg("No TGBP Org");
		try {
			const res = await post(api2, key2, "/v1/payment-requests", {
				amount: "1000",
				merchantWallet: merchant,
			});
			assert.equal(res.status, 422);
			assert.equal(((await res.json()) as any).code, "unsupported_asset");
		} finally {
			await stopApi(api2);
		}
	});

	test("another organisation's request is 404; a normal payment id is not a payment request", async () => {
		setEnv(true);
		const api = await startTestServer({ sandbox: true });
		const { key } = await api.newOrg("Org A");
		const { key: otherKey } = await api.newOrg("Org B");
		try {
			const created = (await (
				await post(api, key, "/v1/payment-requests", { amount: "1000", merchantWallet: merchant })
			).json()) as any;
			const other = await get(api, otherKey, `/v1/payment-requests/${created.id}`);
			assert.equal(other.status, 404);
			const missing = await get(api, key, "/v1/payment-requests/pay_doesnotexist");
			assert.equal(missing.status, 404);
		} finally {
			await stopApi(api);
		}
	});

	test("waiting before any transaction; paid after a matching one; idempotent afterwards", async () => {
		setEnv(true);
		let signatures: string[] = [];
		const seen: Array<{ reference?: string; mint: string; recipientOwner: string }> = [];
		setReferenceLookupForTests(async () => signatures);
		setSolanaVerifyForTests(async (_rpc, input) => {
			seen.push({ reference: input.reference, mint: input.mint, recipientOwner: input.recipientOwner });
			return okVerify(input);
		});
		const api = await startTestServer({ sandbox: true });
		const { key } = await api.newOrg("Pay Org");
		try {
			const created = (await (
				await post(api, key, "/v1/payment-requests", { amount: "2500", merchantWallet: merchant })
			).json()) as any;
			const waiting = (await (await get(api, key, `/v1/payment-requests/${created.id}`)).json()) as any;
			assert.equal(waiting.status, "waiting");
			assert.equal(seen.length, 0);

			signatures = ["customerSig1"];
			const paid = (await (await get(api, key, `/v1/payment-requests/${created.id}`)).json()) as any;
			assert.equal(paid.status, "paid", JSON.stringify(paid));
			assert.equal(paid.signature, "customerSig1");
			assert.match(paid.explorerUrl, /customerSig1/);
			assert.equal(seen[0]!.reference, created.reference);
			assert.equal(seen[0]!.mint, tgbpMint);
			assert.equal(seen[0]!.recipientOwner, merchant);

			// Idempotent: a second read returns the same signature without another look-up.
			signatures = ["someOtherSig"];
			const callsBefore = seen.length;
			const again = (await (await get(api, key, `/v1/payment-requests/${created.id}`)).json()) as any;
			assert.equal(again.status, "paid");
			assert.equal(again.signature, "customerSig1");
			assert.equal(seen.length, callsBefore);

			// The underlying payment is paid with the same evidence.
			const pay = (await (await get(api, key, `/v1/payments/${created.id}`)).json()) as any;
			assert.equal(pay.status, "paid");
		} finally {
			await stopApi(api);
		}
	});

	test("a transaction with the wrong amount, mint or recipient stays waiting", async () => {
		setEnv(true);
		setReferenceLookupForTests(async () => ["badSig"]);
		const api = await startTestServer({ sandbox: true });
		const { key } = await api.newOrg("Wrong Org");
		try {
			for (const reason of [
				"amount_too_low",
				"wrong_mint",
				"wrong_recipient",
				"missing_reference",
				"stale_transaction",
				"not_found",
			] as const) {
				setSolanaVerifyForTests(async () => ({ ok: false, reason, message: reason }));
				const created = (await (
					await post(api, key, "/v1/payment-requests", { amount: "1000", merchantWallet: merchant })
				).json()) as any;
				const st = (await (await get(api, key, `/v1/payment-requests/${created.id}`)).json()) as any;
				assert.equal(st.status, "waiting", reason);
				assert.equal(st.signature, null);
				const pay = (await (await get(api, key, `/v1/payments/${created.id}`)).json()) as any;
				assert.equal(pay.status, "processing", reason);
			}
		} finally {
			await stopApi(api);
		}
	}, 60_000);

	test("RPC trouble is a 502, not a silent paid; a reused signature is skipped", async () => {
		setEnv(true);
		const api = await startTestServer({ sandbox: true });
		const { key } = await api.newOrg("Rpc Org");
		try {
			const a = (await (await post(api, key, "/v1/payment-requests", { amount: "1000", merchantWallet: merchant })).json()) as any;
			const b = (await (await post(api, key, "/v1/payment-requests", { amount: "1000", merchantWallet: merchant })).json()) as any;
			setReferenceLookupForTests(async () => {
				throw new Error("rpc down");
			});
			const down = await get(api, key, `/v1/payment-requests/${a.id}`);
			assert.equal(down.status, 502);
			assert.equal(((await down.json()) as any).code, "rpc_error");

			// Request A is paid with sigX; request B must not accept the same signature.
			setSolanaVerifyForTests(async (_rpc, input) => okVerify(input));
			setReferenceLookupForTests(async () => ["sigX"]);
			const paidA = (await (await get(api, key, `/v1/payment-requests/${a.id}`)).json()) as any;
			assert.equal(paidA.status, "paid");
			const stB = (await (await get(api, key, `/v1/payment-requests/${b.id}`)).json()) as any;
			assert.equal(stB.status, "waiting", JSON.stringify(stB));
		} finally {
			await stopApi(api);
		}
	});

	test("expires 15 minutes after creation and never settles afterwards", async () => {
		setEnv(true);
		setReferenceLookupForTests(async () => ["lateSig"]);
		setSolanaVerifyForTests(async (_rpc, input) => okVerify(input));
		const api = await startTestServer({ sandbox: true });
		const { key } = await api.newOrg("Expiry Org");
		try {
			const created = (await (
				await post(api, key, "/v1/payment-requests", { amount: "1000", merchantWallet: merchant })
			).json()) as any;
			const adv = await post(api, key, "/v1/sandbox/advance-time", { seconds: 15 * 60 });
			assert.equal(adv.status, 200, await adv.text());
			const st = (await (await get(api, key, `/v1/payment-requests/${created.id}`)).json()) as any;
			assert.equal(st.status, "expired", JSON.stringify(st));
			assert.equal(st.signature, null);
			const pay = (await (await get(api, key, `/v1/payments/${created.id}`)).json()) as any;
			assert.notEqual(pay.status, "paid");
		} finally {
			await stopApi(api);
		}
	});

	test("the look-up is throttled to one per window per request", async () => {
		setEnv(true);
		setReferenceThrottleMsForTests(60_000);
		let calls = 0;
		setReferenceLookupForTests(async () => {
			calls += 1;
			return [];
		});
		const api = await startTestServer({ sandbox: true });
		const { key } = await api.newOrg("Throttle Org");
		try {
			const created = (await (
				await post(api, key, "/v1/payment-requests", { amount: "1000", merchantWallet: merchant })
			).json()) as any;
			for (let i = 0; i < 4; i++) {
				const st = (await (await get(api, key, `/v1/payment-requests/${created.id}`)).json()) as any;
				assert.equal(st.status, "waiting");
			}
			assert.equal(calls, 1);
		} finally {
			await stopApi(api);
		}
	});
});
