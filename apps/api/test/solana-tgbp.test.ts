import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { Keypair } from "@solana/web3.js";
import { auth, startTestServer } from "./helpers.ts";
import { resetSolanaRuntimeConfigCache } from "../src/solana/runtime-config.ts";
import { setSolanaVerifyForTests } from "../src/solana/verify.ts";

// CCR-26: GBP -> tGBP on Solana. No real network: verification is stubbed.
const recipient = Keypair.generate().publicKey.toBase58();
const usdcMint = Keypair.generate().publicKey.toBase58();
const tgbpMint = Keypair.generate().publicKey.toBase58();

type Api = Awaited<ReturnType<typeof startTestServer>>;

afterEach(() => {
	setSolanaVerifyForTests(null);
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
	}
	delete process.env.FP_SOLANA_PUBLIC_RPC_URL;
	resetSolanaRuntimeConfigCache();
}

async function stopApi(api: Api): Promise<void> {
	try {
		await api.stop();
	} catch (cause) {
		const msg = cause instanceof Error ? cause.message : String(cause);
		if (!/EBUSY|resource busy|locked/i.test(msg)) throw cause;
	}
}

async function json(res: Response): Promise<any> {
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** £100.00 GBP -> tGBP claim-link payment, funded; returns before the claim is accepted. */
async function fundedTgbpPayment(api: Api, key: string) {
	const rcpRes = await fetch(`${api.base}/v1/recipients`, {
		method: "POST",
		headers: auth(key, { "idempotency-key": "g-rcp-" + Math.random() }),
		body: JSON.stringify({ name: "Recv", kind: "individual", country: "GB" }),
	});
	assert.equal(rcpRes.status, 201);
	const rcp = (await rcpRes.json()) as { id: string };
	const quoteRes = await fetch(`${api.base}/v1/quotes`, {
		method: "POST",
		headers: auth(key, { "idempotency-key": "g-quote-" + Math.random() }),
		body: JSON.stringify({
			source: { type: "bank_account", currency: "GBP", country: "GB" },
			destination: {
				type: "crypto_wallet",
				currency: "TGBP",
				country: "",
				recipientKind: "individual",
			},
			amount: { side: "send", value: { amount: "10000", currency: "GBP" } },
			policy: "cheapest",
			feeMode: "PayerPays",
		}),
	});
	const quote = await json(quoteRes);
	assert.equal(quoteRes.status, 201, JSON.stringify(quote));
	assert.equal(quote.expectedReceive.currency, "TGBP");
	assert.equal(
		quote.route.find((l: { kind: string }) => l.kind === "settle").rail,
		"solana_tgbp",
	);
	const payRes = await fetch(`${api.base}/v1/payments`, {
		method: "POST",
		headers: auth(key, { "idempotency-key": "g-pay-" + Math.random() }),
		body: JSON.stringify({
			quoteId: quote.id,
			recipientId: rcp.id,
			delivery: "claim_link",
			profile: "one_off",
		}),
	});
	const payment = await json(payRes);
	assert.equal(payRes.status, 201, JSON.stringify(payment));
	const fundRes = await fetch(`${api.base}/v1/payments/${payment.id}/fund`, {
		method: "POST",
		headers: auth(key, { "idempotency-key": "g-fund-" + Math.random() }),
		body: "{}",
	});
	assert.equal(fundRes.status, 200, await fundRes.text());
	return { payment, token: payment.claimLink.url.split("/").pop() as string, quote };
}

function acceptBody(network: string, currency: string) {
	return JSON.stringify({
		endpoint: {
			type: "crypto_wallet",
			country: "",
			currency,
			network,
			details: { address: recipient },
			simulated: true,
		},
	});
}

describe("CCR-26 tGBP on Solana", () => {
	test("config lists assets; a GBP payment is verified against the tGBP mint only", async () => {
		setEnv(true);
		let verifiedMint = "";
		setSolanaVerifyForTests(async (_rpc, input) => {
			verifiedMint = input.mint;
			return {
				ok: true,
				signature: input.signature,
				amountMinor: input.amountMinor,
				mint: input.mint,
				recipientOwner: input.recipientOwner,
				slot: 7,
				blockTime: Math.floor(Date.now() / 1000),
			};
		});
		const api = await startTestServer();
		const { key } = await api.newOrg("Solana tGBP Org");
		try {
			const cfgRes = await fetch(`${api.base}/v1/solana/config`);
			const cfg = await json(cfgRes);
			assert.equal(cfgRes.status, 200, JSON.stringify(cfg));
			assert.deepEqual(
				cfg.assets.map((a: { asset: string }) => a.asset),
				["USDC", "TGBP"],
			);
			assert.equal(cfg.usdcMint, usdcMint);

			const { payment, token } = await fundedTgbpPayment(api, key);

			// Wrong network or currency for a TGBP payment is refused.
			const wrongNet = await fetch(`${api.base}/v1/claims/${token}/accept`, {
				method: "POST",
				headers: { "content-type": "application/json", "idempotency-key": "g-acc-bad" },
				body: acceptBody("stellar", "TGBP"),
			});
			assert.equal(wrongNet.status, 422, await wrongNet.text());
			const wrongCur = await fetch(`${api.base}/v1/claims/${token}/accept`, {
				method: "POST",
				headers: { "content-type": "application/json", "idempotency-key": "g-acc-cur" },
				body: acceptBody("solana", "USDC"),
			});
			assert.equal(wrongCur.status, 422, await wrongCur.text());

			const accept = await fetch(`${api.base}/v1/claims/${token}/accept`, {
				method: "POST",
				headers: { "content-type": "application/json", "idempotency-key": "g-acc-ok" },
				body: acceptBody("solana", "TGBP"),
			});
			assert.equal(accept.status, 200, await accept.text());

			const intentRes = await fetch(`${api.base}/v1/payments/${payment.id}/solana/intent`, {
				headers: auth(key),
			});
			const intent = await json(intentRes);
			assert.equal(intentRes.status, 200, JSON.stringify(intent));
			assert.equal(intent.asset, "TGBP");
			assert.equal(intent.mint, tgbpMint);
			assert.equal(intent.decimals, 6);
			// Deprecated aliases equal mint/decimals, also for TGBP.
			assert.equal(intent.usdcMint, tgbpMint);
			assert.equal(intent.usdcDecimals, 6);
			assert.ok(!/USDC/.test(intent.label), intent.label);
			assert.equal(BigInt(intent.amount) > 0n, true);

			const confirmRes = await fetch(`${api.base}/v1/payments/${payment.id}/solana/confirm`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "g-conf" }),
				body: JSON.stringify({ signature: "tgbp-sig-" + "1".repeat(52) }),
			});
			const confirmed = await json(confirmRes);
			assert.equal(confirmRes.status, 200, JSON.stringify(confirmed));
			assert.equal(confirmed.paymentStatus, "paid");
			assert.equal(verifiedMint, tgbpMint, "verification must use the tGBP mint");

			const settle = await api.db.leg.findFirst({
				where: { paymentId: payment.id, kind: "settle" },
			});
			assert.equal(settle?.rail, "solana_tgbp");
			assert.equal(settle?.lockTxRef, null);
			assert.equal(settle?.externalRef, null);
		} finally {
			await stopApi(api);
		}
	}, 120_000);

	test("without FP_SOLANA_TGBP_MINT a tGBP payment gets 422 unsupported_asset", async () => {
		setEnv(false);
		const api = await startTestServer();
		const { key } = await api.newOrg("Solana tGBP Off Org");
		try {
			const cfg = await json(await fetch(`${api.base}/v1/solana/config`));
			assert.deepEqual(
				cfg.assets.map((a: { asset: string }) => a.asset),
				["USDC"],
			);
			const { payment, token } = await fundedTgbpPayment(api, key);
			const accept = await fetch(`${api.base}/v1/claims/${token}/accept`, {
				method: "POST",
				headers: { "content-type": "application/json", "idempotency-key": "g-acc-off" },
				body: acceptBody("solana", "TGBP"),
			});
			assert.equal(accept.status, 200, await accept.text());
			const intentRes = await fetch(`${api.base}/v1/payments/${payment.id}/solana/intent`, {
				headers: auth(key),
			});
			const body = await json(intentRes);
			assert.equal(intentRes.status, 422, JSON.stringify(body));
			assert.equal(body.error?.code ?? body.code, "unsupported_asset");
		} finally {
			await stopApi(api);
		}
	}, 120_000);
});
