import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { Keypair, Transaction } from "@solana/web3.js";
import type { ProviderAdapter } from "@flexipay/domain";
import { auth, startTestServer } from "./helpers.ts";
import type { OrchestratorAdapters } from "../src/orchestrator/index.ts";
import {
	refundSolanaSettleIfOwed,
	resumeSolanaRefund,
	reverseAndCompleteSolanaRefund,
} from "../src/orchestrator/solana-refund.ts";
import { pollProvidersOnce } from "../src/ops/provider-poller.ts";
import { resetSolanaRuntimeConfigCache } from "../src/solana/runtime-config.ts";
import {
	getSolanaRefundRpc,
	setSolanaRefundRpcForTests,
	type SolanaRefundRpc,
} from "../src/solana/treasury-refund.ts";
import { setSolanaVerifyForTests } from "../src/solana/verify.ts";

const treasury = Keypair.generate();
const payer = Keypair.generate().publicKey.toBase58();
const tgbpMint = Keypair.generate().publicKey.toBase58();
const usdcMint = Keypair.generate().publicKey.toBase58();

type Api = Awaited<ReturnType<typeof startTestServer>>;

afterEach(() => {
	setSolanaVerifyForTests(null);
	setSolanaRefundRpcForTests(null);
	resetSolanaRuntimeConfigCache();
	delete process.env.FP_SOLANA_SETTLE_TREASURY;
	delete process.env.FP_SOLANA_SETTLE_TREASURY_SECRET;
	delete process.env.FP_SOLANA_TGBP_MINT;
	delete process.env.FP_SOLANA_TGBP_DECIMALS;
});

function setEnv(): void {
	process.env.FP_SETTLEMENT = "mock";
	process.env.FP_SOLANA_CLUSTER = "devnet";
	process.env.FP_SOLANA_USDC_MINT = usdcMint;
	process.env.FP_SOLANA_USDC_DECIMALS = "6";
	process.env.FP_SOLANA_TGBP_MINT = tgbpMint;
	process.env.FP_SOLANA_TGBP_DECIMALS = "6";
	process.env.FP_SOLANA_SETTLE_TREASURY = treasury.publicKey.toBase58();
	process.env.FP_SOLANA_SETTLE_TREASURY_SECRET = JSON.stringify([
		...treasury.secretKey,
	]);
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

function fakeRefundRpc(
	opts: {
		failFirstSend?: boolean;
		confirmOnSecondSend?: boolean;
	} = {},
) {
	let landed = false;
	let height = 1;
	let sendAttempts = 0;
	const sent: Buffer[] = [];
	const rpc: SolanaRefundRpc = {
		getLatestBlockhash: async () => ({
			blockhash: Keypair.generate().publicKey.toBase58(),
			lastValidBlockHeight: 100,
		}),
		getBlockHeight: async () => height,
		getSignatureStatuses: async (signatures) => ({
			value: signatures.map(() =>
				landed
					? { confirmationStatus: "confirmed" as const, err: null }
					: null,
			),
		}),
		sendRawTransaction: async (raw) => {
			sendAttempts += 1;
			if (opts.failFirstSend && sendAttempts === 1) {
				throw new Error("mock RPC send unavailable");
			}
			sent.push(Buffer.from(raw));
			if (opts.confirmOnSecondSend && sendAttempts === 1) {
				return "pending-signature";
			}
			landed = true;
			return "mock-signature";
		},
	};
	return {
		rpc,
		sent,
		get sendAttempts() {
			return sendAttempts;
		},
		set blockHeight(value: number) {
			height = value;
		},
	};
}

function stubTazapay(
	api: Api,
	opts: { reverseFails?: boolean } = {},
): void {
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
				amountOut: same
					? req.amountIn
					: { amount: req.amountIn.amount, currency: req.outCurrency },
				fee: {
					amount: "0",
					currency: same ? req.outCurrency : req.amountIn.currency,
				},
				fxRate: same ? null : "1",
				estimatedTimeSeconds: 60,
				simulated: true,
			};
		},
		execute: async (leg) => ({
			externalRef: `tazapay-stub:${leg.kind}:${leg.legId}:${leg.attempt}`,
		}),
		status: async (externalRef) =>
			externalRef.includes(":payout:")
				? {
						status: "failed" as const,
						externalRef,
						error: {
							code: "provider_down",
							message: "Tazapay payout failed after settle",
						},
					}
				: { status: "succeeded" as const, externalRef },
		reverse: async (externalRef) => {
			if (opts.reverseFails) throw new Error("mock reverse failed");
			return { externalRef: `reversed:${externalRef}` };
		},
		health: async () => "up" as const,
	};
	const original = api.runtime.getProvider.bind(api.runtime);
	api.runtime.getProvider = (id) =>
		id === "tazapay_sandbox" ? stub : original(id);
	api.runtime.liveProviderIds = ["tazapay_sandbox"];
}

function adaptersOf(api: Api): OrchestratorAdapters {
	return {
		getProvider: api.runtime.getProvider,
		settlement: api.runtime.settlement,
		vaultPayer: api.runtime.vaultPayer,
		now: api.runtime.now,
		claimSealKey: api.runtime.claimSealKey,
		defaultClaimDestination:
			process.env.FP_RECIPIENT_A_ADDRESS ?? api.runtime.vaultPayer,
		partnerProviderIds: new Set(api.runtime.liveProviderIds ?? []),
	};
}

async function json(res: Response): Promise<any> {
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** Direct GB→KE bank payment funded into solana_settle_wait. */
async function fundedDirectKe(api: Api, key: string) {
	const rcpRes = await fetch(`${api.base}/v1/recipients`, {
		method: "POST",
		headers: auth(key, { "idempotency-key": `r-rcp-${Math.random()}` }),
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
		headers: auth(key, { "idempotency-key": `r-ep-${Math.random()}` }),
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
		headers: auth(key, { "idempotency-key": `r-quote-${Math.random()}` }),
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
		quote.route.find((leg: { kind: string }) => leg.kind === "settle")?.rail,
		"solana_tgbp",
	);

	const payRes = await fetch(`${api.base}/v1/payments`, {
		method: "POST",
		headers: auth(key, { "idempotency-key": `r-pay-${Math.random()}` }),
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

	const fundRes = await fetch(`${api.base}/v1/payments/${payment.id}/fund`, {
		method: "POST",
		headers: auth(key, { "idempotency-key": `r-fund-${Math.random()}` }),
		body: "{}",
	});
	const funded = await json(fundRes);
	assert.equal(fundRes.status, 200, JSON.stringify(funded));
	const settle = funded.legs.find((leg: { kind: string }) => leg.kind === "settle");
	assert.equal(settle.status, "processing");
	assert.equal(settle.releaseTxRef, null);
	return { payment: funded, settle };
}

function verifyTransfer(): void {
	setSolanaVerifyForTests(async (_rpc, input) => ({
		ok: true,
		signature: input.signature,
		amountMinor: input.amountMinor,
		mint: input.mint,
		recipientOwner: input.recipientOwner,
		payer,
		slot: 1,
		blockTime: Math.floor(Date.now() / 1000),
	}));
}

async function confirmFundedPayment(
	api: Api,
	key: string,
	paymentId: string,
	signature: string,
): Promise<Response> {
	const intentRes = await fetch(
		`${api.base}/v1/payments/${paymentId}/solana/intent`,
		{ headers: auth(key) },
	);
	assert.equal(intentRes.status, 200, await intentRes.text());
	return fetch(`${api.base}/v1/payments/${paymentId}/solana/confirm`, {
		method: "POST",
		headers: auth(key, {
			"idempotency-key": `r-confirm-${Math.random()}`,
		}),
		body: JSON.stringify({ signature }),
	});
}

async function paymentDetail(api: Api, key: string, paymentId: string) {
	const res = await fetch(`${api.base}/v1/payments/${paymentId}`, {
		headers: auth(key),
	});
	const body = await json(res);
	assert.equal(res.status, 200, JSON.stringify(body));
	return body;
}

describe("CCR-37 Solana treasury refund", { timeout: 120_000 }, () => {
	test("uses the configured Solana RPC when no test override is installed", () => {
		setEnv();
		setSolanaRefundRpcForTests(null);
		const rpc = getSolanaRefundRpc();
		assert.equal(typeof rpc.getLatestBlockhash, "function");
		assert.equal(typeof rpc.sendRawTransaction, "function");
	});

	test("success: refunds the verified treasury amount and exposes refundTxRef", async () => {
		setEnv();
		verifyTransfer();
		const fake = fakeRefundRpc();
		setSolanaRefundRpcForTests(fake.rpc);
		const api = await startTestServer();
		try {
			stubTazapay(api);
			const { key } = await api.newOrg("CCR37 Refund Success");
			const { payment, settle } = await fundedDirectKe(api, key);
			const signature = Keypair.generate().publicKey.toBase58();

			const confirm = await confirmFundedPayment(
				api,
				key,
				payment.id,
				signature,
			);
			const confirmBody = await json(confirm);
			assert.equal(confirm.status, 200, JSON.stringify(confirmBody));

			const detail = await paymentDetail(api, key, payment.id);
			assert.equal(detail.status, "refunded");
			assert.equal(
				detail.legs.find((leg: { kind: string }) => leg.kind === "settle")
					.releaseTxRef,
				signature,
			);

			const refund = await api.db.solanaRefund.findUniqueOrThrow({
				where: { paymentId: payment.id },
			});
			assert.equal(refund.status, "confirmed");
			assert.equal(refund.decimals, 6);
			assert.ok(refund.signature);
			assert.equal(detail.refundTxRef, refund.signature);
			assert.equal(fake.sendAttempts, 1);
			assert.equal(fake.sent.length, 1);

			const row = await api.db.payment.findUniqueOrThrow({
				where: { id: payment.id },
			});
			assert.equal(row.solanaPayer, payer);
			assert.equal(row.solanaSettleMint, tgbpMint);
			assert.equal(row.solanaSettleDestination, treasury.publicKey.toBase58());
			assert.equal(row.solanaSettleDecimals, 6);
			assert.ok(row.solanaSettleAmount);
			assert.equal(refund.amountValue, row.solanaSettleAmount);

			const tx = Transaction.from(fake.sent[0]!);
			assert.equal(
				tx.feePayer?.toBase58(),
				treasury.publicKey.toBase58(),
			);

			// A payment that already reached refunded must not create or resend anything.
			assert.deepEqual(await refundSolanaSettleIfOwed(api.db, payment.id), {
				required: false,
			});
			assert.equal(
				(
					await reverseAndCompleteSolanaRefund(
						api.db,
						payment.id,
						adaptersOf(api),
					)
				).status,
				"refunded",
			);
			assert.equal(
				(await resumeSolanaRefund(api.db, payment.id, adaptersOf(api)))
					.status,
				"refunded",
			);

			// Two workers (poller and request path) starting the same refund at once must send
			// one transaction, never two.
			await api.db.solanaRefund.delete({ where: { paymentId: payment.id } });
			await api.db.payment.update({
				where: { id: payment.id },
				data: { status: "refunding" },
			});
			const before = fake.sent.length;
			const raced = await Promise.all([
				refundSolanaSettleIfOwed(api.db, payment.id),
				refundSolanaSettleIfOwed(api.db, payment.id),
			]);
			assert.equal(fake.sent.length - before, 1, JSON.stringify(raced));
			assert.ok(raced.some((r) => r.required && r.status === "confirmed"));
			await api.db.payment.update({
				where: { id: payment.id },
				data: { status: "refunded" },
			});

			// Inconsistent settled rows must fail closed instead of using the legacy refund path.
			await api.db.payment.update({
				where: { id: payment.id },
				data: {
					status: "refunding",
					solanaSettleDestination: Keypair.generate().publicKey.toBase58(),
				},
			});
			await assert.rejects(
				refundSolanaSettleIfOwed(api.db, payment.id),
				/does not match FP_SOLANA_SETTLE_TREASURY/,
			);
			await api.db.payment.update({
				where: { id: payment.id },
				data: {
					solanaSettleDestination: treasury.publicKey.toBase58(),
					solanaPayer: null,
				},
			});
			await assert.rejects(
				refundSolanaSettleIfOwed(api.db, payment.id),
				/data is incomplete/,
			);
			await api.db.payment.update({
				where: { id: payment.id },
				data: { solanaPayer: payer },
			});
			await api.db.leg.update({
				where: { id: settle.id },
				data: { releaseTxRef: null },
			});
			await assert.rejects(
				refundSolanaSettleIfOwed(api.db, payment.id),
				/no release transaction evidence/,
			);
		} finally {
			await stopApi(api);
		}
	});

	test("RPC send failure then retry: reuses the persisted signed transaction", async () => {
		setEnv();
		verifyTransfer();
		const fake = fakeRefundRpc({ failFirstSend: true });
		setSolanaRefundRpcForTests(fake.rpc);
		const api = await startTestServer();
		try {
			stubTazapay(api);
			const { key } = await api.newOrg("CCR37 Refund Retry");
			const { payment } = await fundedDirectKe(api, key);

			const confirm = await confirmFundedPayment(
				api,
				key,
				payment.id,
				Keypair.generate().publicKey.toBase58(),
			);
			assert.equal(confirm.status, 200, await confirm.text());

			const before = await api.db.payment.findUniqueOrThrow({
				where: { id: payment.id },
			});
			assert.equal(before.status, "refunding");
			const first = await api.db.solanaRefund.findUniqueOrThrow({
				where: { paymentId: payment.id },
			});
			assert.equal(first.status, "submitted");
			assert.ok(first.signature);
			assert.equal(fake.sendAttempts, 1);

			await pollProvidersOnce(api.db, adaptersOf(api));

			const after = await api.db.payment.findUniqueOrThrow({
				where: { id: payment.id },
			});
			assert.equal(after.status, "refunded");
			assert.equal(fake.sendAttempts, 2);
			const retried = await api.db.solanaRefund.findUniqueOrThrow({
				where: { paymentId: payment.id },
			});
			assert.equal(retried.status, "confirmed");
			assert.equal(retried.signature, first.signature);
			assert.equal(
				await api.db.solanaRefund.count({
					where: { paymentId: payment.id },
				}),
				1,
			);
			const detail = await paymentDetail(api, key, payment.id);
			assert.equal(detail.refundTxRef, first.signature);
		} finally {
			await stopApi(api);
		}
	});

	test("no double send: a confirmed refund is never sent again", async () => {
		setEnv();
		verifyTransfer();
		const fake = fakeRefundRpc();
		setSolanaRefundRpcForTests(fake.rpc);
		const api = await startTestServer();
		try {
			stubTazapay(api);
			const { key } = await api.newOrg("CCR37 Refund No Double");
			const { payment } = await fundedDirectKe(api, key);

			const confirm = await confirmFundedPayment(
				api,
				key,
				payment.id,
				Keypair.generate().publicKey.toBase58(),
			);
			assert.equal(confirm.status, 200, await confirm.text());
			const refund = await api.db.solanaRefund.findUniqueOrThrow({
				where: { paymentId: payment.id },
			});
			assert.equal(refund.status, "confirmed");
			assert.equal(fake.sendAttempts, 1);

			// Simulate a crash after confirmation but before the payment transition: the poller must
			// read the confirmed signature and finish without broadcasting again.
			await api.db.payment.update({
				where: { id: payment.id },
				data: { status: "refunding" },
			});
			await pollProvidersOnce(api.db, adaptersOf(api));

			assert.equal(
				(await api.db.payment.findUniqueOrThrow({
					where: { id: payment.id },
				})).status,
				"refunded",
			);
			assert.equal(fake.sendAttempts, 1);
			const after = await api.db.solanaRefund.findUniqueOrThrow({
				where: { paymentId: payment.id },
			});
			assert.equal(after.status, "confirmed");
			assert.equal(after.signature, refund.signature);
		} finally {
			await stopApi(api);
		}
	});

	test("an expired pending refund is rebuilt and confirmed on retry", async () => {
		setEnv();
		verifyTransfer();
		const fake = fakeRefundRpc({ confirmOnSecondSend: true });
		setSolanaRefundRpcForTests(fake.rpc);
		const api = await startTestServer();
		try {
			stubTazapay(api);
			const { key } = await api.newOrg("CCR37 Refund Expired");
			const { payment } = await fundedDirectKe(api, key);

			const confirm = await confirmFundedPayment(
				api,
				key,
				payment.id,
				Keypair.generate().publicKey.toBase58(),
			);
			assert.equal(confirm.status, 200, await confirm.text());

			const first = await api.db.solanaRefund.findUniqueOrThrow({
				where: { paymentId: payment.id },
			});
			assert.equal(first.status, "submitted");
			assert.equal(first.attempts, 1);
			assert.equal(fake.sendAttempts, 1);
			assert.equal(
				(
					await api.db.payment.findUniqueOrThrow({
						where: { id: payment.id },
					})
				).status,
				"refunding",
			);

			fake.blockHeight = 101;
			await pollProvidersOnce(api.db, adaptersOf(api));

			assert.equal(
				(
					await api.db.payment.findUniqueOrThrow({
						where: { id: payment.id },
					})
				).status,
				"refunded",
			);
			const retried = await api.db.solanaRefund.findUniqueOrThrow({
				where: { paymentId: payment.id },
			});
			assert.equal(retried.status, "confirmed");
			assert.equal(retried.attempts, 2);
			assert.notEqual(retried.signature, first.signature);
			assert.equal(fake.sendAttempts, 2);
		} finally {
			await stopApi(api);
		}
	});

	test("a reversal failure leaves the payment failed after the on-chain refund", async () => {
		setEnv();
		verifyTransfer();
		const fake = fakeRefundRpc();
		setSolanaRefundRpcForTests(fake.rpc);
		const api = await startTestServer();
		try {
			stubTazapay(api, { reverseFails: true });
			const { key } = await api.newOrg("CCR37 Reverse Failed");
			const { payment } = await fundedDirectKe(api, key);

			const confirm = await confirmFundedPayment(
				api,
				key,
				payment.id,
				Keypair.generate().publicKey.toBase58(),
			);
			assert.equal(confirm.status, 200, await confirm.text());

			assert.equal(
				(
					await api.db.payment.findUniqueOrThrow({
						where: { id: payment.id },
					})
				).status,
				"failed",
			);
			const refund = await api.db.solanaRefund.findUniqueOrThrow({
				where: { paymentId: payment.id },
			});
			assert.equal(refund.status, "confirmed");
			assert.equal(fake.sendAttempts, 1);
			const detail = await paymentDetail(api, key, payment.id);
			assert.equal(detail.refundTxRef, refund.signature);
		} finally {
			await stopApi(api);
		}
	});
});
