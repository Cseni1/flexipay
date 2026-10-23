import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, startTestServer, type TestServer } from "./helpers.ts";

let t: TestServer;

beforeAll(async () => {
	t = await startTestServer();
}, 180_000);

afterAll(async () => {
	await t.stop();
});

describe("CC3b claim + sandbox", () => {
	it("sandbox reset wipes org demo data; fail-next / health respond 200", async () => {
		const { key } = await t.newOrg("Demo Platform");
		await fetch(`${t.base}/v1/recipients`, {
			method: "POST",
			headers: auth(key),
			body: JSON.stringify({
				name: "Worker A",
				kind: "individual",
				country: "US",
			}),
		});
		const reset = await fetch(`${t.base}/v1/sandbox/reset`, {
			method: "POST",
			headers: auth(key, { "idempotency-key": "reset-1" }),
			body: "{}",
		});
		expect(reset.status).toBe(200);

		const list = await fetch(`${t.base}/v1/recipients`, { headers: auth(key) });
		expect(((await list.json()) as { recipients: unknown[] }).recipients).toEqual(
			[],
		);

		const fail = await fetch(`${t.base}/v1/sandbox/fail-next`, {
			method: "POST",
			headers: auth(key),
			body: JSON.stringify({ providerId: "sim_bank_us_ach", count: 1 }),
		});
		expect(fail.status).toBe(200);

		const health = await fetch(`${t.base}/v1/sandbox/provider-health`, {
			method: "POST",
			headers: auth(key),
			body: JSON.stringify({ providerId: "sim_bank_us_ach", health: "up" }),
		});
		expect(health.status).toBe(200);
	});

	it("claim get + accept releases settle after fund (crypto)", async () => {
		const { key } = await t.newOrg("Demo Platform");
		// Clear shared sim controls left by prior sandbox tests.
		await fetch(`${t.base}/v1/sandbox/reset`, {
			method: "POST",
			headers: auth(key),
			body: "{}",
		});
		const recipient = await (
			await fetch(`${t.base}/v1/recipients`, {
				method: "POST",
				headers: auth(key),
				body: JSON.stringify({
					name: "Worker A",
					kind: "individual",
					country: "PH",
				}),
			})
		).json() as { id: string };

		const quote = await (
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
		).json() as { id: string };

		const payment = await (
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
		).json() as {
			id: string;
			claimLink: { url: string } | null;
		};
		expect(payment.claimLink?.url).toBeTruthy();
		const token = payment.claimLink!.url.split("/").pop()!;

		await fetch(`${t.base}/v1/payments/${payment.id}/fund`, {
			method: "POST",
			headers: auth(key),
			body: "{}",
		});

		const view = await fetch(`${t.base}/v1/claims/${token}`);
		expect(view.status).toBe(200);
		const claim = (await view.json()) as {
			status: string;
			paymentStatus: string;
		};
		expect(claim.status).toBe("open");
		expect(claim.paymentStatus).toBe("processing");

		const accept = await fetch(`${t.base}/v1/claims/${token}/accept`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				endpoint: {
					type: "crypto_wallet",
					country: "",
					currency: "USDC",
					network: "stellar",
					details: {
						address: "GDEMODEST0000000000000000000000000000000000000000000",
					},
					simulated: true,
				},
			}),
		});
		expect(accept.status).toBe(200);
		const accepted = (await accept.json()) as {
			paymentStatus: string;
			claim: { status: string };
		};
		expect(accepted.paymentStatus).toBe("paid");
		expect(accepted.claim.status).toBe("accepted");

		const settle = await t.db.leg.findFirst({
			where: { paymentId: payment.id, kind: "settle" },
		});
		expect(settle?.externalRef).toBeTruthy();
		expect(settle?.releaseTxRef).toBeTruthy();
		expect(settle?.releaseTxRef).not.toBe(settle?.externalRef);
	});
});
