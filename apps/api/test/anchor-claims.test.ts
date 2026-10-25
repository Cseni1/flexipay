import { Keypair, TransactionBuilder, Account, Networks, Operation, Asset, Memo } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AnchorClaimGateway } from "../src/anchor/claim-anchor-gateway.ts";
import { auth, startTestServer, type TestServer } from "./helpers.ts";

let t: TestServer;

beforeAll(async () => {
	t = await startTestServer();
}, 180_000);

afterAll(async () => {
	await t.stop();
});

const CLASSIC = Keypair.random();
const CLASSIC_ADDRESS = CLASSIC.publicKey();
const CLASSIC_SECRET = CLASSIC.secret();
const ANCHOR_DEST = Keypair.random().publicKey();
const NETWORK = Networks.TESTNET;

function mockGateway(opts?: {
	status?: string;
	stellarTransactionId?: string;
	slowStartMs?: number;
	onStart?: () => void;
}): {
	gw: AnchorClaimGateway;
	counts: { starts: number; prices: number; polls: number; pays: number };
} {
	const counts = { starts: 0, prices: 0, polls: 0, pays: 0 };
	const gw: AnchorClaimGateway = {
		sellAsset: () =>
			"stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
		homeDomain: () => "testanchor.stellar.org",
		async indicativePrice(sellAmount) {
			counts.prices += 1;
			return {
				indicative: true,
				context: "sep6",
				sellAmount,
				buyAmount: "4.95",
				buyAsset: "iso4217:USD",
				sellAsset:
					"stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
				price: "0.99",
			};
		},
		async startWithdraw({ amount }) {
			opts?.onStart?.();
			if (opts?.slowStartMs) {
				await new Promise((r) => setTimeout(r, opts.slowStartMs));
			}
			counts.starts += 1;
			return {
				anchorTxId: `anchor-tx-${Date.now()}-${counts.starts}-${amount}-${Math.random().toString(36).slice(2, 8)}`,
				urlSanitised: "https://testanchor.stellar.org/sep24/transaction",
				interactiveUrl:
					"https://testanchor.stellar.org/sep24/transaction?token=SECRET_JWT_TOKEN",
				kind: "withdrawal",
			};
		},
		async getWithdrawStatus({ anchorTxId }) {
			counts.polls += 1;
			const status = opts?.status ?? "pending_user_transfer_start";
			return {
				anchorTxId,
				status,
				amountIn: "5",
				withdrawAnchorAccount: ANCHOR_DEST,
				withdrawMemoPresent: true,
				withdrawMemo: "memo-secret",
				withdrawMemoType: "text",
				anchorStellarTransactionId: opts?.stellarTransactionId,
				terminal: status === "completed" || status === "error",
				success: status === "completed",
				failure: status === "error",
			};
		},
	};
	return { gw, counts };
}

async function openFundedClaim(key: string): Promise<{
	token: string;
	paymentId: string;
}> {
	const recipient = (await (
		await fetch(`${t.base}/v1/recipients`, {
			method: "POST",
			headers: auth(key),
			body: JSON.stringify({
				name: "Worker A",
				kind: "individual",
				country: "PH",
			}),
		})
	).json()) as { id: string };
	const quote = (await (
		await fetch(`${t.base}/v1/quotes`, {
			method: "POST",
			headers: auth(key),
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
					value: { amount: "100000", currency: "USD" },
				},
				policy: "cheapest",
				feeMode: "PayerPays",
			}),
		})
	).json()) as { id: string };
	const payment = (await (
		await fetch(`${t.base}/v1/payments`, {
			method: "POST",
			headers: auth(key),
			body: JSON.stringify({
				quoteId: quote.id,
				recipientId: recipient.id,
				delivery: "claim_link",
				profile: "one_off",
			}),
		})
	).json()) as { id: string; claimLink: { url: string } | null };
	await fetch(`${t.base}/v1/payments/${payment.id}/fund`, {
		method: "POST",
		headers: auth(key),
		body: "{}",
	});
	const token = payment.claimLink!.url.split("/").pop()!;
	return { token, paymentId: payment.id };
}

async function releaseToClassic(token: string): Promise<void> {
	const accept = await fetch(`${t.base}/v1/claims/${token}/accept`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			endpoint: {
				type: "crypto_wallet",
				country: "",
				currency: "USDC",
				network: "stellar",
				details: { address: CLASSIC_ADDRESS },
				simulated: true,
			},
		}),
	});
	expect(accept.status).toBe(200);
}

function installPayMocks(
	counts: { pays: number },
	opts?: { rejectSubmit?: boolean },
) {
	const knownSuccess = new Set<string>();
	const knownFailed = new Set<string>();
	t.runtime.anchorAsset = {
		code: "USDC",
		issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
		networkPassphrase: NETWORK,
	};
	t.runtime.buildAnchorClassicPayment = async ({ source, expectation }) => {
		const account = new Account(source.publicKey(), "1");
		const now = Math.floor(Date.now() / 1000);
		const tx = new TransactionBuilder(account, {
			fee: "100",
			networkPassphrase: NETWORK,
		})
			.addOperation(
				Operation.payment({
					destination: expectation.destination,
					asset: new Asset(expectation.asset.code, expectation.asset.issuer),
					amount: expectation.amount,
				}),
			)
			.addMemo(Memo.text(expectation.memo))
			.setTimebounds(now, now + 120)
			.build();
		tx.sign(source);
		return {
			txHash: Buffer.from(tx.hash()).toString("hex"),
			signedTx: tx,
			timeBounds: { minTime: now, maxTime: now + 120 },
			destination: expectation.destination,
			amount: expectation.amount,
			memoPresent: true as const,
			asset: {
				code: expectation.asset.code,
				issuer: expectation.asset.issuer,
				networkPassphrase: NETWORK,
			},
		};
	};
	t.runtime.submitAnchorClassicPayment = async ({ expectedTxHash }) => {
		counts.pays += 1;
		if (opts?.rejectSubmit) {
			knownFailed.add(expectedTxHash);
			const err = new Error("tx_failed op_underfunded");
			(err as { response?: { status: number } }).response = { status: 400 };
			throw err;
		}
		knownSuccess.add(expectedTxHash);
		return {
			txHash: expectedTxHash,
			destination: ANCHOR_DEST,
			amount: "5",
			memoPresent: true as const,
			asset: {
				code: "USDC",
				issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
				networkPassphrase: NETWORK,
			},
		};
	};
	t.runtime.lookupClassicTxByHash = async (hash) => {
		if (knownSuccess.has(hash)) return { found: true, successful: true };
		if (knownFailed.has(hash)) return { found: true, successful: false };
		return { found: false };
	};
}

beforeEach(() => {
	delete t.runtime.anchorGateway;
	delete t.runtime.resolveAnchorAuthSecret;
	delete t.runtime.anchorAsset;
	delete t.runtime.buildAnchorClassicPayment;
	delete t.runtime.submitAnchorClassicPayment;
	delete t.runtime.lookupClassicTxByHash;
});

describe("CCR-22 anchor claim routes (review fix)", () => {
	it(
		"indicative-price shape; indicative ≠ binding",
		async () => {
			const { key } = await t.newOrg("Anchor Indicative Org");
			const { token } = await openFundedClaim(key);
			const mock = mockGateway();
			t.runtime.anchorGateway = mock.gw;

			const res = await fetch(
				`${t.base}/v1/claims/${token}/anchor/indicative-price`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sellAmount: "5" }),
				},
			);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				indicative: boolean;
				context: string;
			};
			expect(body.indicative).toBe(true);
			expect(body.context).toBe("sep6");
		},
		30_000,
	);

	it("amount optional defaults to net; excess and bad type rejected", async () => {
		const { key } = await t.newOrg("Anchor Amount Org");
		const { token, paymentId } = await openFundedClaim(key);
		await releaseToClassic(token);
		const mock = mockGateway();
		t.runtime.anchorGateway = mock.gw;
		t.runtime.resolveAnchorAuthSecret = (a) =>
			a === CLASSIC_ADDRESS ? CLASSIC_SECRET : undefined;

		const settle = await t.db.leg.findFirstOrThrow({
			where: { paymentId, kind: "settle" },
		});
		// Force net to 5 USDC major (5e7 minor) so default is within anchor limits.
		await t.db.leg.update({
			where: { id: settle.id },
			data: { amountOutValue: "50000000", amountOutCurrency: "USDC" },
		});

		const badType = await fetch(`${t.base}/v1/claims/${token}/anchor/withdraw`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "wd-bad-type",
			},
			body: JSON.stringify({ type: "ewallet" }),
		});
		expect(badType.status).toBe(400);

		const excess = await fetch(`${t.base}/v1/claims/${token}/anchor/withdraw`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "wd-excess",
			},
			body: JSON.stringify({ amount: "9" }),
		});
		expect(excess.status).toBe(422);
		expect(((await excess.json()) as { code: string }).code).toBe(
			"amount_out_of_range",
		);

		const ok = await fetch(`${t.base}/v1/claims/${token}/anchor/withdraw`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "wd-default-net",
			},
			body: JSON.stringify({}),
		});
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as {
			interactiveUrl?: string;
			urlSanitised: string;
		};
		expect(body.interactiveUrl).toContain("SECRET_JWT_TOKEN");
		expect(body.urlSanitised).not.toContain("SECRET");
	});

	it("first withdraw returns interactiveUrl; replay/cache/DB never keep JWT", async () => {
		const { key } = await t.newOrg("Anchor URL Org");
		const { token, paymentId } = await openFundedClaim(key);
		await releaseToClassic(token);
		await t.db.leg.updateMany({
			where: { paymentId, kind: "settle" },
			data: { amountOutValue: "50000000", amountOutCurrency: "USDC" },
		});
		const mock = mockGateway();
		t.runtime.anchorGateway = mock.gw;
		t.runtime.resolveAnchorAuthSecret = (a) =>
			a === CLASSIC_ADDRESS ? CLASSIC_SECRET : undefined;

		const first = await fetch(`${t.base}/v1/claims/${token}/anchor/withdraw`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "wd-url-1",
			},
			body: JSON.stringify({ amount: "5", type: "bank_account" }),
		});
		expect(first.status).toBe(200);
		const body1 = (await first.json()) as {
			anchorTxId: string;
			interactiveUrl?: string;
			urlSanitised: string;
		};
		expect(body1.interactiveUrl).toContain("token=");

		const replay = await fetch(`${t.base}/v1/claims/${token}/anchor/withdraw`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "wd-url-1",
			},
			body: JSON.stringify({ amount: "5", type: "bank_account" }),
		});
		expect(replay.status).toBe(200);
		const body2 = (await replay.json()) as { interactiveUrl?: string };
		expect(body2.interactiveUrl).toBeUndefined();
		expect(mock.counts.starts).toBe(1);

		const link = await t.db.claimLink.findUniqueOrThrow({
			where: { paymentId },
		});
		expect(JSON.stringify(link)).not.toContain("SECRET_JWT");
		expect(link.anchorUrlSanitised).not.toContain("?");

		const org = await t.db.payment.findUniqueOrThrow({ where: { id: paymentId } });
		const cached = await t.db.idempotencyRecord.findFirst({
			where: { organizationId: org.organizationId, key: "wd-url-1" },
		});
		expect(JSON.stringify(cached?.responseBody ?? {})).not.toContain("SECRET_JWT");
		expect(JSON.stringify(cached?.responseBody ?? {})).not.toContain(
			"interactiveUrl",
		);
	});

	it("parallel withdraw with different idempotency keys creates one session", async () => {
		const { key } = await t.newOrg("Anchor Concurrency Org");
		const { token, paymentId } = await openFundedClaim(key);
		await releaseToClassic(token);
		await t.db.leg.updateMany({
			where: { paymentId, kind: "settle" },
			data: { amountOutValue: "50000000", amountOutCurrency: "USDC" },
		});
		const mock = mockGateway({ slowStartMs: 80 });
		t.runtime.anchorGateway = mock.gw;
		t.runtime.resolveAnchorAuthSecret = (a) =>
			a === CLASSIC_ADDRESS ? CLASSIC_SECRET : undefined;

		const [a, b] = await Promise.all([
			fetch(`${t.base}/v1/claims/${token}/anchor/withdraw`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "wd-par-a",
				},
				body: JSON.stringify({ amount: "5" }),
			}),
			fetch(`${t.base}/v1/claims/${token}/anchor/withdraw`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "wd-par-b",
				},
				body: JSON.stringify({ amount: "5" }),
			}),
		]);
		const statuses = [a.status, b.status].sort();
		expect(statuses[0]).toBe(200);
		expect([200, 409]).toContain(statuses[1]);
		expect(mock.counts.starts).toBe(1);
		const link = await t.db.claimLink.findUniqueOrThrow({
			where: { paymentId },
		});
		expect(link.anchorTxId).toBeTruthy();
	});

	it("GET status is read-only: separate refs; no payment side effect", async () => {
		const { key } = await t.newOrg("Anchor Status Org");
		const { token, paymentId } = await openFundedClaim(key);
		await releaseToClassic(token);
		await t.db.leg.updateMany({
			where: { paymentId, kind: "settle" },
			data: { amountOutValue: "50000000", amountOutCurrency: "USDC" },
		});
		const payCounts = { pays: 0 };
		const mock = mockGateway({
			status: "completed",
			stellarTransactionId: "aa".repeat(32),
		});
		t.runtime.anchorGateway = mock.gw;
		t.runtime.resolveAnchorAuthSecret = (a) =>
			a === CLASSIC_ADDRESS ? CLASSIC_SECRET : undefined;
		installPayMocks(payCounts);

		const started = await fetch(
			`${t.base}/v1/claims/${token}/anchor/withdraw`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "wd-status-ro",
				},
				body: JSON.stringify({ amount: "5" }),
			},
		);
		const { anchorTxId } = (await started.json()) as { anchorTxId: string };

		const ok = await fetch(
			`${t.base}/v1/claims/${token}/anchor/withdraw/${anchorTxId}`,
		);
		expect(ok.status).toBe(200);
		const statusBody = (await ok.json()) as Record<string, unknown>;
		expect(statusBody.terminal).toBe(true);
		expect(statusBody.anchorStellarTransactionId).toBe("aa".repeat(32));
		expect(statusBody.vaultReleaseTxRef).toBeTruthy();
		expect(statusBody.anchorPaymentTxHash).toBeUndefined();
		expect(statusBody).not.toHaveProperty("stellarTransactionId");
		expect(statusBody).not.toHaveProperty("withdrawMemo");
		expect(payCounts.pays).toBe(0);

		const link = await t.db.claimLink.findUniqueOrThrow({
			where: { paymentId },
		});
		expect(link.anchorStellarTransactionId).toBe("aa".repeat(32));
		expect(link.anchorPaymentTxHash).toBeNull();
	});

	it("/pay persists before send; unresolved replay → 202 without resubmit", async () => {
		const { key } = await t.newOrg("Anchor Pay Org");
		const { token, paymentId } = await openFundedClaim(key);
		await releaseToClassic(token);
		await t.db.leg.updateMany({
			where: { paymentId, kind: "settle" },
			data: { amountOutValue: "50000000", amountOutCurrency: "USDC" },
		});
		const payCounts = { pays: 0 };
		const mock = mockGateway({ status: "pending_user_transfer_start" });
		t.runtime.anchorGateway = mock.gw;
		t.runtime.resolveAnchorAuthSecret = (a) =>
			a === CLASSIC_ADDRESS ? CLASSIC_SECRET : undefined;
		installPayMocks(payCounts);

		const started = await fetch(
			`${t.base}/v1/claims/${token}/anchor/withdraw`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "wd-pay-start",
				},
				body: JSON.stringify({ amount: "5" }),
			},
		);
		const { anchorTxId } = (await started.json()) as { anchorTxId: string };

		const payOk = await fetch(
			`${t.base}/v1/claims/${token}/anchor/withdraw/${anchorTxId}/pay`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "pay-1",
				},
				body: "{}",
			},
		);
		expect(payOk.status).toBe(200);
		const paid = (await payOk.json()) as {
			status: string;
			anchorPaymentTxHash: string;
		};
		expect(paid.status).toBe("submitted");
		expect(paid.anchorPaymentTxHash).toMatch(/^[a-f0-9]{64}$/);
		expect(payCounts.pays).toBe(1);

		const link = await t.db.claimLink.findUniqueOrThrow({
			where: { paymentId },
		});
		expect(link.anchorPayPendingTxHash).toBe(paid.anchorPaymentTxHash);
		expect(link.anchorPaymentTxHash).toBe(paid.anchorPaymentTxHash);
		expect(link.anchorPayPendingSealed).toBeTruthy();

		// Unresolved replay: clear success mark so Horizon lookup is NOT_FOUND.
		// Retained envelope must NOT authorise resubmit.
		await t.db.claimLink.update({
			where: { paymentId },
			data: {
				anchorPayStatus: "uncertain",
				anchorPaymentTxHash: null,
			},
		});
		t.runtime.lookupClassicTxByHash = async () => ({ found: false });
		payCounts.pays = 0;
		const pending = await fetch(
			`${t.base}/v1/claims/${token}/anchor/withdraw/${anchorTxId}/pay`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "pay-uncertain",
				},
				body: "{}",
			},
		);
		expect(pending.status).toBe(202);
		expect(payCounts.pays).toBe(0);
		const pendingBody = (await pending.json()) as {
			status: string;
			pendingTxHash: string;
		};
		expect(pendingBody.status).toBe("pending");
		expect(pendingBody.pendingTxHash).toBe(link.anchorPayPendingTxHash);
	});

	it("parallel /pay: only reservation winner submits", async () => {
		const { key } = await t.newOrg("Anchor Pay Conc Org");
		const { token, paymentId } = await openFundedClaim(key);
		await releaseToClassic(token);
		await t.db.leg.updateMany({
			where: { paymentId, kind: "settle" },
			data: { amountOutValue: "50000000", amountOutCurrency: "USDC" },
		});
		const payCounts = { pays: 0 };
		t.runtime.anchorGateway = mockGateway({
			status: "pending_user_transfer_start",
		}).gw;
		t.runtime.resolveAnchorAuthSecret = (a) =>
			a === CLASSIC_ADDRESS ? CLASSIC_SECRET : undefined;
		installPayMocks(payCounts);

		const started = await fetch(
			`${t.base}/v1/claims/${token}/anchor/withdraw`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "wd-pay-par",
				},
				body: JSON.stringify({ amount: "5" }),
			},
		);
		const { anchorTxId } = (await started.json()) as { anchorTxId: string };

		const [p1, p2] = await Promise.all([
			fetch(
				`${t.base}/v1/claims/${token}/anchor/withdraw/${anchorTxId}/pay`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"idempotency-key": "pay-par-a",
					},
					body: "{}",
				},
			),
			fetch(
				`${t.base}/v1/claims/${token}/anchor/withdraw/${anchorTxId}/pay`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"idempotency-key": "pay-par-b",
					},
					body: "{}",
				},
			),
		]);
		const codes = [p1.status, p2.status].sort();
		expect(codes[0]).toBe(200);
		expect([200, 202]).toContain(codes[1]);
		expect(payCounts.pays).toBe(1);
	});

	it("/pay definitive Horizon reject → 409 failed; no uncertain", async () => {
		const { key } = await t.newOrg("Anchor Pay Reject Org");
		const { token, paymentId } = await openFundedClaim(key);
		await releaseToClassic(token);
		await t.db.leg.updateMany({
			where: { paymentId, kind: "settle" },
			data: { amountOutValue: "50000000", amountOutCurrency: "USDC" },
		});
		const payCounts = { pays: 0 };
		t.runtime.anchorGateway = mockGateway({
			status: "pending_user_transfer_start",
		}).gw;
		t.runtime.resolveAnchorAuthSecret = (a) =>
			a === CLASSIC_ADDRESS ? CLASSIC_SECRET : undefined;
		installPayMocks(payCounts, { rejectSubmit: true });

		const started = await fetch(
			`${t.base}/v1/claims/${token}/anchor/withdraw`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "wd-pay-rej",
				},
				body: JSON.stringify({ amount: "5" }),
			},
		);
		const { anchorTxId } = (await started.json()) as { anchorTxId: string };
		const pay = await fetch(
			`${t.base}/v1/claims/${token}/anchor/withdraw/${anchorTxId}/pay`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "pay-rej",
				},
				body: "{}",
			},
		);
		expect(pay.status).toBe(409);
		const link = await t.db.claimLink.findUniqueOrThrow({
			where: { paymentId },
		});
		expect(link.anchorPayStatus).toBe("failed");
		expect(payCounts.pays).toBe(1);
	});

	it("/pay refuses new payment unless pending_user_transfer_start", async () => {
		const { key } = await t.newOrg("Anchor Pay Status Gate");
		const { token, paymentId } = await openFundedClaim(key);
		await releaseToClassic(token);
		await t.db.leg.updateMany({
			where: { paymentId, kind: "settle" },
			data: { amountOutValue: "50000000", amountOutCurrency: "USDC" },
		});
		t.runtime.anchorGateway = mockGateway({ status: "incomplete" }).gw;
		t.runtime.resolveAnchorAuthSecret = (a) =>
			a === CLASSIC_ADDRESS ? CLASSIC_SECRET : undefined;
		installPayMocks({ pays: 0 });

		const started = await fetch(
			`${t.base}/v1/claims/${token}/anchor/withdraw`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "wd-pay-gate",
				},
				body: JSON.stringify({ amount: "5" }),
			},
		);
		const { anchorTxId } = (await started.json()) as { anchorTxId: string };
		const pay = await fetch(
			`${t.base}/v1/claims/${token}/anchor/withdraw/${anchorTxId}/pay`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "pay-gate",
				},
				body: "{}",
			},
		);
		expect(pay.status).toBe(409);
		expect(((await pay.json()) as { code: string }).code).toBe("invalid_state");
	});

	it("different body same Idempotency-Key → 409", async () => {
		const { key } = await t.newOrg("Anchor Idempotency Body");
		const { token, paymentId } = await openFundedClaim(key);
		await releaseToClassic(token);
		await t.db.leg.updateMany({
			where: { paymentId, kind: "settle" },
			data: { amountOutValue: "50000000", amountOutCurrency: "USDC" },
		});
		t.runtime.anchorGateway = mockGateway().gw;
		t.runtime.resolveAnchorAuthSecret = (a) =>
			a === CLASSIC_ADDRESS ? CLASSIC_SECRET : undefined;

		const first = await fetch(`${t.base}/v1/claims/${token}/anchor/withdraw`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "wd-body-diff",
			},
			body: JSON.stringify({ amount: "5" }),
		});
		expect(first.status).toBe(200);

		const conflict = await fetch(
			`${t.base}/v1/claims/${token}/anchor/withdraw`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "wd-body-diff",
				},
				body: JSON.stringify({ amount: "4" }),
			},
		);
		expect(conflict.status).toBe(409);
		expect(((await conflict.json()) as { code: string }).code).toBe(
			"idempotency_conflict",
		);
	});

	it("expired claim → 409 expired", async () => {
		const { key } = await t.newOrg("Anchor Expired Org");
		const { token, paymentId } = await openFundedClaim(key);
		t.runtime.anchorGateway = mockGateway().gw;
		await t.db.claimLink.update({
			where: { paymentId },
			data: { expiresAt: new Date("2000-01-01T00:00:00.000Z") },
		});
		const res = await fetch(
			`${t.base}/v1/claims/${token}/anchor/indicative-price`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sellAmount: "5" }),
			},
		);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { code: string }).code).toBe("expired");
	});
});
