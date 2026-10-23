import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockSettlementAdapter } from "@flexipay/adapters-sim";
import { auth, startTestServer, type TestServer } from "./helpers.ts";

let t: TestServer;

beforeAll(async () => {
	t = await startTestServer();
}, 180_000);

afterAll(async () => {
	await t.stop();
});

const CRYPTO_ENDPOINT = {
	type: "crypto_wallet",
	country: "",
	currency: "USDC",
	network: "stellar",
	details: { address: "GDEMODEST0000000000000000000000000000000000000000000" },
	simulated: true,
};

async function json<T>(res: Response): Promise<T> {
	return (await res.json()) as T;
}

describe("CCR-15 public API: fee drift never pays", () => {
	it("quote at the vault fee → vault fee halves → fund 409 fee_drift → claim accept does not pay", async () => {
		const { key } = await t.newOrg("Demo Platform");
		const recipient = await json<{ id: string }>(
			await fetch(`${t.base}/v1/recipients`, {
				method: "POST",
				headers: auth(key),
				body: JSON.stringify({ name: "Worker A", kind: "individual", country: "PH" }),
			}),
		);
		const quote = await json<{ id: string }>(
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
					amount: { side: "send", value: { amount: "100000", currency: "USD" } },
					policy: "cheapest",
					feeMode: "PayerPays",
				}),
			}),
		);
		const payment = await json<{ id: string; claimLink: { url: string } | null }>(
			await fetch(`${t.base}/v1/payments`, {
				method: "POST",
				headers: auth(key),
				body: JSON.stringify({
					quoteId: quote.id,
					recipientId: recipient.id,
					delivery: "claim_link",
					profile: "one_off",
				}),
			}),
		);
		const token = payment.claimLink!.url.split("/").pop()!;

		// "Restart" with a different vault fee than the quote used.
		const quotedBps = await t.runtime.settlement.feeBps();
		const original = t.runtime.settlement;
		t.runtime.settlement = new MockSettlementAdapter({
			token: "USDC",
			treasury: "GDEMOTREASURY0000000000000000000000000000000000000000",
			feeBps: Math.max(1, Math.floor(quotedBps / 2)),
			now: () => new Date(),
		});
		try {
			const fund = await fetch(`${t.base}/v1/payments/${payment.id}/fund`, {
				method: "POST",
				headers: auth(key),
				body: "{}",
			});
			expect(fund.status).toBe(409);
			expect((await json<{ code: string }>(fund)).code).toBe("fee_drift");

			const accept = await fetch(`${t.base}/v1/claims/${token}/accept`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ endpoint: CRYPTO_ENDPOINT }),
			});
			expect(accept.status).toBe(409);
			expect((await json<{ code: string }>(accept)).code).toBe("settle_failed");
		} finally {
			t.runtime.settlement = original;
		}

		const row = await t.db.payment.findUniqueOrThrow({
			where: { id: payment.id },
			include: { legs: true },
		});
		expect(row.status).toBe("refunded");
		expect(row.status).not.toBe("paid");
		const settle = row.legs.find((l) => l.kind === "settle")!;
		expect(settle.status).toBe("failed");
		expect(settle.errorCode).toBe("fee_drift");
		expect(settle.externalRef).toBeTruthy();
		expect(settle.lockTxRef).toBeTruthy();
		expect(settle.releaseTxRef).toBeTruthy();

		// Public views carry no secret and the same non-paid status.
		const view = await json<{ status: string; paymentStatus: string }>(
			await fetch(`${t.base}/v1/claims/${token}`),
		);
		expect(view.paymentStatus).toBe("refunded");
		const detail = await fetch(`${t.base}/v1/payments/${payment.id}`, { headers: auth(key) });
		const body = JSON.stringify(await detail.json());
		expect(body).not.toMatch(/secret|sealed|nonce/i);
	});
});
