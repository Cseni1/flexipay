import { Keypair } from "@stellar/stellar-sdk";
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

function mockGateway(opts?: {
	status?: string;
	stellarTransactionId?: string;
}): {
	gw: AnchorClaimGateway;
	counts: { starts: number; prices: number; polls: number };
} {
	const counts = { starts: 0, prices: 0, polls: 0 };
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
			counts.starts += 1;
			return {
				anchorTxId: `anchor-tx-${Date.now()}-${counts.starts}-${amount}-${Math.random().toString(36).slice(2, 8)}`,
				urlSanitised: "https://testanchor.stellar.org/sep24/transaction",
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
				withdrawAnchorAccount:
					"GANCHORACCOUNT000000000000000000000000000000000000000",
				withdrawMemoPresent: true,
				stellarTransactionId: opts?.stellarTransactionId,
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

beforeEach(() => {
	delete t.runtime.anchorGateway;
	delete t.runtime.resolveAnchorAuthSecret;
});

describe("CCR-22 anchor claim routes", () => {
	it("indicative-price: request/response shape; indicative ≠ binding", async () => {
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
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({
			indicative: true,
			context: "sep6",
			sellAmount: "5",
			buyAmount: "4.95",
			buyAsset: "iso4217:USD",
			sellAsset:
				"stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
			price: "0.99",
		});
		expect(body.indicative).toBe(true);
		expect(mock.counts.prices).toBe(1);
	});

	it("indicative-price: amount out of range → 400", async () => {
		const { key } = await t.newOrg("Anchor Range Org");
		const { token } = await openFundedClaim(key);
		t.runtime.anchorGateway = mockGateway().gw;
		const res = await fetch(
			`${t.base}/v1/claims/${token}/anchor/indicative-price`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sellAmount: "11" }),
			},
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { code: string }).code).toBe(
			"validation_error",
		);
	});

	it("withdraw: requires Idempotency-Key; refuses without vault release", async () => {
		const { key } = await t.newOrg("Anchor Withdraw Guards");
		const { token } = await openFundedClaim(key);
		t.runtime.anchorGateway = mockGateway().gw;
		t.runtime.resolveAnchorAuthSecret = (addr) =>
			addr === CLASSIC_ADDRESS ? CLASSIC_SECRET : undefined;

		const noKey = await fetch(`${t.base}/v1/claims/${token}/anchor/withdraw`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ amount: "5" }),
		});
		expect(noKey.status).toBe(400);
		expect(((await noKey.json()) as { code: string }).code).toBe(
			"missing_idempotency_key",
		);

		const noRelease = await fetch(
			`${t.base}/v1/claims/${token}/anchor/withdraw`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "wd-no-release-1",
				},
				body: JSON.stringify({ amount: "5" }),
			},
		);
		expect(noRelease.status).toBe(409);
		expect(((await noRelease.json()) as { code: string }).code).toBe(
			"invalid_state",
		);
	});

	it("withdraw: starts after classic release; idempotent; no blind re-start", async () => {
		const { key } = await t.newOrg("Anchor Withdraw Happy");
		const { token, paymentId } = await openFundedClaim(key);
		await releaseToClassic(token);
		const mock = mockGateway();
		t.runtime.anchorGateway = mock.gw;
		t.runtime.resolveAnchorAuthSecret = (addr) =>
			addr === CLASSIC_ADDRESS ? CLASSIC_SECRET : undefined;

		const first = await fetch(`${t.base}/v1/claims/${token}/anchor/withdraw`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "wd-happy-1",
			},
			body: JSON.stringify({ amount: "5", type: "bank_account" }),
		});
		expect(first.status).toBe(200);
		const body1 = (await first.json()) as {
			anchorTxId: string;
			urlSanitised: string;
			kind: string;
		};
		expect(body1.kind).toBe("withdrawal");
		expect(body1.urlSanitised).not.toMatch(/[?&]/);
		expect(mock.counts.starts).toBe(1);

		const link = await t.db.claimLink.findUniqueOrThrow({
			where: { paymentId },
		});
		expect(link.anchorTxId).toBe(body1.anchorTxId);
		expect(link.recipientClassicAddress).toBe(CLASSIC_ADDRESS);
		const settle = await t.db.leg.findFirstOrThrow({
			where: { paymentId, kind: "settle" },
		});
		expect(settle.releaseTxRef).toBeTruthy();
		expect(link.anchorPaymentTxHash).toBeNull();

		const replay = await fetch(`${t.base}/v1/claims/${token}/anchor/withdraw`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "wd-happy-1",
			},
			body: JSON.stringify({ amount: "5", type: "bank_account" }),
		});
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual(body1);
		expect(mock.counts.starts).toBe(1);

		const otherKey = await fetch(
			`${t.base}/v1/claims/${token}/anchor/withdraw`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "wd-happy-2",
				},
				body: JSON.stringify({ amount: "5" }),
			},
		);
		expect(otherKey.status).toBe(200);
		expect(((await otherKey.json()) as { anchorTxId: string }).anchorTxId).toBe(
			body1.anchorTxId,
		);
		expect(mock.counts.starts).toBe(1);
	});

	it("status: cross-claim anchorTxId → 404; terminal fields separate from release", async () => {
		const { key } = await t.newOrg("Anchor Status Org");
		const a = await openFundedClaim(key);
		const b = await openFundedClaim(key);
		await releaseToClassic(a.token);
		await releaseToClassic(b.token);

		const mock = mockGateway({
			status: "completed",
			stellarTransactionId: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
		});
		t.runtime.anchorGateway = mock.gw;
		t.runtime.resolveAnchorAuthSecret = (addr) =>
			addr === CLASSIC_ADDRESS ? CLASSIC_SECRET : undefined;

		const started = await fetch(
			`${t.base}/v1/claims/${a.token}/anchor/withdraw`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "wd-status-a",
				},
				body: JSON.stringify({ amount: "5" }),
			},
		);
		const { anchorTxId } = (await started.json()) as { anchorTxId: string };

		const cross = await fetch(
			`${t.base}/v1/claims/${b.token}/anchor/withdraw/${anchorTxId}`,
		);
		expect(cross.status).toBe(404);
		expect(((await cross.json()) as { code: string }).code).toBe("not_found");

		const ok = await fetch(
			`${t.base}/v1/claims/${a.token}/anchor/withdraw/${anchorTxId}`,
		);
		expect(ok.status).toBe(200);
		const statusBody = (await ok.json()) as {
			anchorTxId: string;
			status: string;
			withdrawMemoPresent: boolean;
			stellarTransactionId?: string;
		};
		expect(statusBody.status).toBe("completed");
		expect(statusBody.withdrawMemoPresent).toBe(true);
		expect(statusBody.stellarTransactionId).toBe(
			"aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
		);
		expect(statusBody).not.toHaveProperty("withdrawMemo");
		expect(statusBody).not.toHaveProperty("releaseTxRef");

		const link = await t.db.claimLink.findUniqueOrThrow({
			where: { paymentId: a.paymentId },
		});
		expect(link.anchorPaymentTxHash).toBe(statusBody.stellarTransactionId);
		const settle = await t.db.leg.findFirstOrThrow({
			where: { paymentId: a.paymentId, kind: "settle" },
		});
		expect(settle.releaseTxRef).toBeTruthy();
		expect(settle.releaseTxRef).not.toBe(link.anchorPaymentTxHash);
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

	it("public auth: no Bearer required on claim anchor routes", async () => {
		const { key } = await t.newOrg("Anchor Public Auth");
		const { token } = await openFundedClaim(key);
		t.runtime.anchorGateway = mockGateway().gw;
		const res = await fetch(
			`${t.base}/v1/claims/${token}/anchor/indicative-price`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sellAmount: "2.5" }),
			},
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("www-authenticate")).toBeNull();
	});
});
