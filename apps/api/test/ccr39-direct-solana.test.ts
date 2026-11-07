import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { ProviderAdapter } from "@flexipay/domain";
import { auth, startTestServer } from "./helpers.ts";
import { resetSolanaRuntimeConfigCache } from "../src/solana/runtime-config.ts";
import { setSolanaVerifyForTests } from "../src/solana/verify.ts";

const treasury = Keypair.generate().publicKey.toBase58();
const usdcMint = Keypair.generate().publicKey.toBase58();
const tgbpMint = Keypair.generate().publicKey.toBase58();
const claimRecipient = Keypair.generate().publicKey.toBase58();

type Api = Awaited<ReturnType<typeof startTestServer>>;

afterEach(() => {
	setSolanaVerifyForTests(null);
	resetSolanaRuntimeConfigCache();
	delete process.env.FP_SOLANA_SETTLE_TREASURY;
	delete process.env.FP_SOLANA_TGBP_MINT;
	delete process.env.FP_SOLANA_TGBP_DECIMALS;
});

function setEnv(opts: { treasury?: boolean; tgbp?: boolean } = {}): void {
	process.env.FP_SETTLEMENT = "mock";
	process.env.FP_SOLANA_CLUSTER = "devnet";
	process.env.FP_SOLANA_USDC_MINT = usdcMint;
	process.env.FP_SOLANA_USDC_DECIMALS = "6";
	if (opts.tgbp !== false) {
		process.env.FP_SOLANA_TGBP_MINT = tgbpMint;
		process.env.FP_SOLANA_TGBP_DECIMALS = "6";
	}
	if (opts.treasury !== false) {
		process.env.FP_SOLANA_SETTLE_TREASURY = treasury;
	} else {
		delete process.env.FP_SOLANA_SETTLE_TREASURY;
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

function stubTazapay(api: Api): void {
	const stub: ProviderAdapter = {
		id: "tazapay_sandbox",
		capabilities: () => ({
			providerId: "tazapay_sandbox",
			countries: ["KE", "PH"],
			currencies: ["KES", "PHP", "TGBP", "GBP"],
			endpointTypes: ["bank_account"],
			legKinds: ["convert", "payout"],
			limits: null,
			simulated: true,
		}),
		quote: async (req) => {
			const same = req.amountIn.currency === req.outCurrency;
			return {
				providerId: "tazapay_sandbox",
				amountIn: req.amountIn,
				// 1:1 stub FX so post-settle TGBP → local (KES/PHP) quotes clear.
				amountOut: same
					? req.amountIn
					: { amount: req.amountIn.amount, currency: req.outCurrency },
				fee: { amount: "0", currency: same ? req.outCurrency : req.amountIn.currency },
				fxRate: same ? null : "1",
				estimatedTimeSeconds: 60,
				simulated: true,
			};
		},
		execute: async (leg) => ({
			externalRef: `tazapay-stub:${leg.kind}:${leg.legId}:${leg.attempt}`,
		}),
		status: async (externalRef) => ({
			status: "succeeded" as const,
			externalRef,
		}),
		reverse: async () => {
			throw new Error("not reversible");
		},
		health: async () => "up" as const,
	};
	const original = api.runtime.getProvider.bind(api.runtime);
	api.runtime.getProvider = (id) =>
		id === "tazapay_sandbox" ? stub : original(id);
	api.runtime.liveProviderIds = ["tazapay_sandbox"];
}

/** Direct GB→KE bank payment funded into solana_settle_wait. */
async function fundedDirectKe(api: Api, key: string) {
	const rcpRes = await fetch(`${api.base}/v1/recipients`, {
		method: "POST",
		headers: auth(key, { "idempotency-key": "d-rcp-" + Math.random() }),
		body: JSON.stringify({
			name: "Worker KE",
			kind: "individual",
			country: "KE",
		}),
	});
	const rcp = (await json(rcpRes)) as { id: string };
	assert.equal(rcpRes.status, 201, JSON.stringify(rcp));

	const epRes = await fetch(`${api.base}/v1/endpoints`, {
		method: "POST",
		headers: auth(key, { "idempotency-key": "d-ep-" + Math.random() }),
		body: JSON.stringify({
			recipientId: rcp.id,
			type: "bank_account",
			country: "KE",
			currency: "KES",
			network: null,
			details: {
				accountNumber: "1234567890",
				bankName: "Equity Bank",
				swiftCode: "EQBLKENA",
			},
			simulated: true,
		}),
	});
	const ep = (await json(epRes)) as { id: string };
	assert.equal(epRes.status, 201, JSON.stringify(ep));

	const quoteRes = await fetch(`${api.base}/v1/quotes`, {
		method: "POST",
		headers: auth(key, { "idempotency-key": "d-quote-" + Math.random() }),
		body: JSON.stringify({
			source: { type: "bank_account", currency: "GBP", country: "GB" },
			destination: {
				type: "bank_account",
				currency: "KES",
				country: "KE",
				recipientKind: "individual",
			},
			amount: { side: "send", value: { amount: "10000", currency: "GBP" } },
			policy: "cheapest",
			feeMode: "PayerPays",
		}),
	});
	const quote = await json(quoteRes);
	assert.equal(quoteRes.status, 201, JSON.stringify(quote));
	assert.equal(
		quote.route.find((l: { kind: string }) => l.kind === "settle")?.rail,
		"solana_tgbp",
	);

	const payRes = await fetch(`${api.base}/v1/payments`, {
		method: "POST",
		headers: auth(key, { "idempotency-key": "d-pay-" + Math.random() }),
		body: JSON.stringify({
			quoteId: quote.id,
			recipientId: rcp.id,
			endpointId: ep.id,
			delivery: "direct",
			profile: "one_off",
		}),
	});
	const payment = await json(payRes);
	assert.equal(payRes.status, 201, JSON.stringify(payment));
	assert.equal(payment.delivery, "direct");
	assert.equal(payment.claimLink, null);

	const fundRes = await fetch(`${api.base}/v1/payments/${payment.id}/fund`, {
		method: "POST",
		headers: auth(key, { "idempotency-key": "d-fund-" + Math.random() }),
		body: "{}",
	});
	const funded = await json(fundRes);
	assert.equal(fundRes.status, 200, JSON.stringify(funded));
	const settle = funded.legs.find((l: { kind: string }) => l.kind === "settle");
	assert.equal(settle.status, "processing");
	assert.equal(settle.releaseTxRef, null);
	return { payment: funded, quote, settle };
}

describe("CCR-39 direct Solana settle to treasury", { timeout: 60_000 }, () => {
	test("direct intent uses treasury, settle amountIn, and stores reference", async () => {
		setEnv();
		const api = await startTestServer();
		try {
			stubTazapay(api);
			const { key } = await api.newOrg("CCR39 Intent");
			const { payment, settle } = await fundedDirectKe(api, key);

			const intentRes = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/intent`,
				{ headers: auth(key) },
			);
			const intent = await json(intentRes);
			assert.equal(intentRes.status, 200, JSON.stringify(intent));
			assert.equal(intent.recipient, treasury);
			assert.equal(intent.asset, "TGBP");
			assert.equal(intent.mint, tgbpMint);
			assert.equal(intent.decimals, 6);
			assert.match(intent.reference, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
			assert.ok(intent.intentIssuedAt);

			const flooredDomain = BigInt(settle.amountIn.amount);
			// Domain 7dp → mint 6dp: divide by 10 after floor.
			const expectedMint = (flooredDomain / 10n).toString();
			assert.equal(intent.amount, expectedMint);

			const row = await api.db.payment.findUniqueOrThrow({
				where: { id: payment.id },
			});
			assert.equal(row.solanaPayReference, intent.reference);
			assert.ok(row.solanaIntentAt);

			const again = await json(
				await fetch(`${api.base}/v1/payments/${payment.id}/solana/intent`, {
					headers: auth(key),
				}),
			);
			assert.equal(again.reference, intent.reference);
			assert.equal(again.intentIssuedAt, intent.intentIssuedAt);
		} finally {
			await stopApi(api);
		}
	});

	test("unset treasury → 409; claim-link intent unchanged", async () => {
		setEnv({ treasury: false });
		const api = await startTestServer();
		try {
			stubTazapay(api);
			const { key } = await api.newOrg("CCR39 No Treasury");
			const { payment } = await fundedDirectKe(api, key);
			const intentRes = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/intent`,
				{ headers: auth(key) },
			);
			const body = await json(intentRes);
			assert.equal(intentRes.status, 409, JSON.stringify(body));
			assert.match(String(body.message), /treasury not configured/i);

			// Claim-link path still works without the treasury env.
			process.env.FP_SOLANA_USDC_MINT = usdcMint;
			process.env.FP_SOLANA_USDC_DECIMALS = "6";
			resetSolanaRuntimeConfigCache();
			const rcpRes = await fetch(`${api.base}/v1/recipients`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "c-rcp-" + Math.random() }),
				body: JSON.stringify({
					name: "Claim Recv",
					kind: "individual",
					country: "GB",
				}),
			});
			assert.equal(rcpRes.status, 201);
			const rcp = (await rcpRes.json()) as { id: string };
			const quoteRes = await fetch(`${api.base}/v1/quotes`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "c-quote-" + Math.random() }),
				body: JSON.stringify({
					source: { type: "bank_account", currency: "GBP", country: "GB" },
					destination: {
						type: "crypto_wallet",
						currency: "TGBP",
						country: "",
						recipientKind: "individual",
					},
					amount: {
						side: "send",
						value: { amount: "10000", currency: "GBP" },
					},
					policy: "cheapest",
					feeMode: "PayerPays",
				}),
			});
			const quote = await json(quoteRes);
			assert.equal(quoteRes.status, 201, JSON.stringify(quote));
			const payRes = await fetch(`${api.base}/v1/payments`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "c-pay-" + Math.random() }),
				body: JSON.stringify({
					quoteId: quote.id,
					recipientId: rcp.id,
					delivery: "claim_link",
					profile: "one_off",
				}),
			});
			const claimPay = await json(payRes);
			assert.equal(payRes.status, 201, JSON.stringify(claimPay));
			assert.equal(
				(
					await fetch(`${api.base}/v1/payments/${claimPay.id}/fund`, {
						method: "POST",
						headers: auth(key, {
							"idempotency-key": "c-fund-" + Math.random(),
						}),
						body: "{}",
					})
				).status,
				200,
			);
			const token = claimPay.claimLink.url.split("/").pop() as string;
			const accept = await fetch(`${api.base}/v1/claims/${token}/accept`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "c-accept-" + Math.random(),
				},
				body: JSON.stringify({
					endpoint: {
						type: "crypto_wallet",
						country: "",
						currency: "TGBP",
						network: "solana",
						details: { address: claimRecipient },
						simulated: true,
					},
				}),
			});
			assert.equal(accept.status, 200, await accept.text());
			const claimIntent = await json(
				await fetch(`${api.base}/v1/payments/${claimPay.id}/solana/intent`, {
					headers: auth(key),
				}),
			);
			assert.equal(claimIntent.recipient, claimRecipient);
			assert.notEqual(claimIntent.recipient, treasury);
		} finally {
			await stopApi(api);
		}
	});

	test("confirm verifies treasury+reference, continues payout, replay idempotent, reuse 409", async () => {
		setEnv();
		const okSig = "ok-sig-" + "9".repeat(52);
		const otherSig = "other-sig-" + "8".repeat(48);
		const seen: Array<{
			recipientOwner: string;
			reference: string;
			amountMinor: bigint;
		}> = [];

		setSolanaVerifyForTests(async (_rpc, input) => {
			seen.push({
				recipientOwner: input.recipientOwner,
				reference: input.reference ?? "",
				amountMinor: input.amountMinor,
			});
			return {
				ok: true,
				signature: input.signature,
				amountMinor: input.amountMinor,
				mint: input.mint,
				recipientOwner: input.recipientOwner,
				payer: "PayerWallet1111111111111111111111111111111111",
				slot: 1,
				blockTime: Math.floor(Date.now() / 1000),
			};
		});

		const api = await startTestServer();
		try {
			stubTazapay(api);
			const { key } = await api.newOrg("CCR39 Confirm");
			const { payment } = await fundedDirectKe(api, key);
			const intent = await json(
				await fetch(`${api.base}/v1/payments/${payment.id}/solana/intent`, {
					headers: auth(key),
				}),
			);
			assert.equal(intent.recipient, treasury);

			const confirmRes = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/confirm`,
				{
					method: "POST",
					headers: auth(key, {
						"idempotency-key": "d-confirm-" + Math.random(),
					}),
					body: JSON.stringify({ signature: okSig }),
				},
			);
			const confirmed = await json(confirmRes);
			assert.equal(confirmRes.status, 200, JSON.stringify(confirmed));
			assert.ok(
				confirmed.paymentStatus === "processing" ||
					confirmed.paymentStatus === "paid",
				JSON.stringify(confirmed),
			);
			assert.equal(confirmed.signature, okSig);
			assert.equal(seen[0]?.recipientOwner, treasury);
			assert.equal(seen[0]?.reference, intent.reference);
			assert.equal(seen[0]?.amountMinor.toString(), intent.amount);

			const detail = await json(
				await fetch(`${api.base}/v1/payments/${payment.id}`, {
					headers: auth(key),
				}),
			);
			const settle = detail.legs.find(
				(l: { kind: string }) => l.kind === "settle",
			);
			assert.equal(settle.status, "succeeded");
			assert.equal(settle.releaseTxRef, okSig);
			const payout = detail.legs.find(
				(l: { kind: string }) => l.kind === "payout",
			);
			assert.ok(
				payout.status === "succeeded" || payout.status === "processing",
				JSON.stringify(payout),
			);
			assert.ok(payout.externalRef);

			const replay = await json(
				await fetch(`${api.base}/v1/payments/${payment.id}/solana/confirm`, {
					method: "POST",
					headers: auth(key, {
						"idempotency-key": "d-confirm-replay-" + Math.random(),
					}),
					body: JSON.stringify({ signature: okSig }),
				}),
			);
			assert.equal(replay.signature, okSig);
			assert.ok(
				replay.paymentStatus === "processing" || replay.paymentStatus === "paid",
			);

			const reused = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/confirm`,
				{
					method: "POST",
					headers: auth(key, {
						"idempotency-key": "d-confirm-reuse-" + Math.random(),
					}),
					body: JSON.stringify({ signature: otherSig }),
				},
			);
			// Settle already has releaseTxRef=okSig → conflict with a different signature.
			assert.equal(reused.status, 409, await reused.text());
		} finally {
			await stopApi(api);
		}
	});

	test("signature reused on another payment → 409", async () => {
		setEnv();
		const sharedSig = "shared-sig-" + "7".repeat(50);
		setSolanaVerifyForTests(async (_rpc, input) => ({
			ok: true,
			signature: input.signature,
			amountMinor: input.amountMinor,
			mint: input.mint,
			recipientOwner: input.recipientOwner,
			payer: "PayerWallet1111111111111111111111111111111111",
			slot: 1,
			blockTime: Math.floor(Date.now() / 1000),
		}));

		const api = await startTestServer();
		try {
			stubTazapay(api);
			const { key } = await api.newOrg("CCR39 Reuse");
			const first = await fundedDirectKe(api, key);
			await fetch(`${api.base}/v1/payments/${first.payment.id}/solana/intent`, {
				headers: auth(key),
			});
			assert.equal(
				(
					await fetch(
						`${api.base}/v1/payments/${first.payment.id}/solana/confirm`,
						{
							method: "POST",
							headers: auth(key, {
								"idempotency-key": "r1-" + Math.random(),
							}),
							body: JSON.stringify({ signature: sharedSig }),
						},
					)
				).status,
				200,
			);

			const second = await fundedDirectKe(api, key);
			await fetch(`${api.base}/v1/payments/${second.payment.id}/solana/intent`, {
				headers: auth(key),
			});
			const reuse = await fetch(
				`${api.base}/v1/payments/${second.payment.id}/solana/confirm`,
				{
					method: "POST",
					headers: auth(key, { "idempotency-key": "r2-" + Math.random() }),
					body: JSON.stringify({ signature: sharedSig }),
				},
			);
			const body = await json(reuse);
			assert.equal(reuse.status, 409, JSON.stringify(body));
			assert.equal(body.code, "signature_reused");
		} finally {
			await stopApi(api);
		}
	});
});
