import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, startTestServer, type TestServer } from "./helpers.ts";

let t: TestServer;

beforeAll(async () => {
	t = await startTestServer();
}, 180_000);

afterAll(async () => {
	await t.stop();
});

describe("CC3a quotes / payments / fund / cancel / events", () => {
	it("quotes → create → fund domestic → paid; events list; cancel path", async () => {
		const { key } = await t.newOrg("Demo Platform");

		const recipientRes = await fetch(`${t.base}/v1/recipients`, {
			method: "POST",
			headers: auth(key, { "idempotency-key": "rcp-1" }),
			body: JSON.stringify({
				name: "Worker A",
				kind: "individual",
				country: "US",
			}),
		});
		expect(recipientRes.status).toBe(201);
		const recipient = (await recipientRes.json()) as { id: string };

		const quoteRes = await fetch(`${t.base}/v1/quotes`, {
			method: "POST",
			headers: auth(key, { "idempotency-key": "quo-1" }),
			body: JSON.stringify({
				source: { type: "bank_account", currency: "USD", country: "US" },
				destination: {
					type: "bank_account",
					currency: "USD",
					country: "US",
					recipientKind: "individual",
				},
				amount: { side: "send", value: { amount: "10000", currency: "USD" } },
				policy: "cheapest",
			}),
		});
		expect(quoteRes.status).toBe(201);
		const quote = (await quoteRes.json()) as {
			id: string;
			route: { kind: string; amountIn: { amount: string } }[];
			feeMode: string | null;
			simulated: boolean;
		};
		expect(quote.feeMode).toBeNull();
		expect(quote.simulated).toBe(true);
		expect(quote.route.length).toBeGreaterThanOrEqual(2);
		expect(quote.route[0]?.amountIn.amount).toBe("10000");

		const payRes = await fetch(`${t.base}/v1/payments`, {
			method: "POST",
			headers: auth(key, { "idempotency-key": "pay-1" }),
			body: JSON.stringify({
				quoteId: quote.id,
				recipientId: recipient.id,
				delivery: "direct",
				profile: "domestic",
				externalId: "ext-dom-1",
			}),
		});
		expect(payRes.status).toBe(201);
		const payment = (await payRes.json()) as {
			id: string;
			status: string;
			legs: { amountIn: { amount: string }; kind: string }[];
		};
		expect(payment.status).toBe("awaiting_funding");
		expect(payment.legs[0]?.amountIn.amount).toBe(
			quote.route[0]?.amountIn.amount,
		);

		const fundRes = await fetch(`${t.base}/v1/payments/${payment.id}/fund`, {
			method: "POST",
			headers: auth(key, { "idempotency-key": "fund-1" }),
			body: "{}",
		});
		expect(fundRes.status).toBe(200);
		const funded = (await fundRes.json()) as { status: string };
		expect(funded.status).toBe("paid");

		const detailRes = await fetch(`${t.base}/v1/payments/${payment.id}`, {
			headers: auth(key),
		});
		expect(detailRes.status).toBe(200);
		const detail = (await detailRes.json()) as {
			events: { type: string }[];
			legs: { externalRef: string | null }[];
		};
		expect(detail.events.map((e) => e.type)).toEqual(
			expect.arrayContaining([
				"payment.created",
				"payment.funded",
				"payment.paid",
			]),
		);

		const eventsRes = await fetch(`${t.base}/v1/events`, { headers: auth(key) });
		expect(eventsRes.status).toBe(200);
		const events = (await eventsRes.json()) as { events: unknown[] };
		expect(events.events.length).toBeGreaterThan(0);

		const listRes = await fetch(`${t.base}/v1/payments`, { headers: auth(key) });
		expect(listRes.status).toBe(200);
		const list = (await listRes.json()) as { payments: { id: string }[] };
		expect(list.payments.some((p) => p.id === payment.id)).toBe(true);

		// Cancel another payment before fund
		const quote2 = await (
			await fetch(`${t.base}/v1/quotes`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "quo-2" }),
				body: JSON.stringify({
					source: { type: "bank_account", currency: "USD", country: "US" },
					destination: {
						type: "bank_account",
						currency: "USD",
						country: "US",
						recipientKind: "individual",
					},
					amount: {
						side: "send",
						value: { amount: "20000", currency: "USD" },
					},
					policy: "cheapest",
				}),
			})
		).json() as { id: string };

		const pay2 = await (
			await fetch(`${t.base}/v1/payments`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "pay-2" }),
				body: JSON.stringify({
					quoteId: quote2.id,
					recipientId: recipient.id,
					delivery: "direct",
					profile: "domestic",
				}),
			})
		).json() as { id: string };

		const cancelRes = await fetch(`${t.base}/v1/payments/${pay2.id}/cancel`, {
			method: "POST",
			headers: auth(key, { "idempotency-key": "cancel-1" }),
			body: "{}",
		});
		expect(cancelRes.status).toBe(200);
		expect(((await cancelRes.json()) as { status: string }).status).toBe(
			"cancelled",
		);
	});

	it("settle quote requires feeMode (CCR-8); crypto claim_link create returns claim url", async () => {
		const { key } = await t.newOrg("Demo Platform");
		const recipient = await (
			await fetch(`${t.base}/v1/recipients`, {
				method: "POST",
				headers: auth(key),
				body: JSON.stringify({
					name: "Worker B",
					kind: "individual",
					country: "PH",
				}),
			})
		).json() as { id: string };

		const noFee = await fetch(`${t.base}/v1/quotes`, {
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
			}),
		});
		expect(noFee.status).toBe(422);

		const quoteRes = await fetch(`${t.base}/v1/quotes`, {
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
		});
		expect(quoteRes.status).toBe(201);
		const quote = (await quoteRes.json()) as {
			id: string;
			feeMode: string;
			route: { kind: string; simulated: boolean }[];
			fees: { settleUnlockedRemainder: unknown };
		};
		expect(quote.feeMode).toBe("PayerPays");
		expect(quote.route.some((l) => l.kind === "settle")).toBe(true);
		const settle = quote.route.find((l) => l.kind === "settle")!;
		// CCR-10: mock settlement → simulated true (not inferred from rail alone in product sense)
		expect(settle.simulated).toBe(true);

		const payRes = await fetch(`${t.base}/v1/payments`, {
			method: "POST",
			headers: auth(key),
			body: JSON.stringify({
				quoteId: quote.id,
				recipientId: recipient.id,
				delivery: "claim_link",
				profile: "one_off",
			}),
		});
		expect(payRes.status).toBe(201);
		const payment = (await payRes.json()) as {
			id: string;
			claimLink: { url: string; expiresAt: string } | null;
		};
		expect(payment.claimLink?.url).toMatch(/\/v1\/claims\/[0-9a-f]+$/);
	});

	it("rejects expired quote; duplicate externalId → 409; idempotent POST replay; org isolation", async () => {
		const a = await t.newOrg("Demo Platform");
		const b = await t.newOrg("Demo Platform B");

		const recipient = await (
			await fetch(`${t.base}/v1/recipients`, {
				method: "POST",
				headers: auth(a.key),
				body: JSON.stringify({
					name: "Worker A",
					kind: "individual",
					country: "US",
				}),
			})
		).json() as { id: string };

		const quote = await (
			await fetch(`${t.base}/v1/quotes`, {
				method: "POST",
				headers: auth(a.key),
				body: JSON.stringify({
					source: { type: "bank_account", currency: "USD", country: "US" },
					destination: {
						type: "bank_account",
						currency: "USD",
						country: "US",
						recipientKind: "individual",
					},
					amount: {
						side: "send",
						value: { amount: "10000", currency: "USD" },
					},
					policy: "cheapest",
				}),
			})
		).json() as { id: string };

		await t.db.quote.update({
			where: { id: quote.id },
			data: { validUntil: new Date("2000-01-01T00:00:00.000Z") },
		});
		const expiredPay = await fetch(`${t.base}/v1/payments`, {
			method: "POST",
			headers: auth(a.key),
			body: JSON.stringify({
				quoteId: quote.id,
				recipientId: recipient.id,
				delivery: "direct",
				profile: "domestic",
			}),
		});
		expect(expiredPay.status).toBe(422);

		const quote2 = await (
			await fetch(`${t.base}/v1/quotes`, {
				method: "POST",
				headers: auth(a.key),
				body: JSON.stringify({
					source: { type: "bank_account", currency: "USD", country: "US" },
					destination: {
						type: "bank_account",
						currency: "USD",
						country: "US",
						recipientKind: "individual",
					},
					amount: {
						side: "send",
						value: { amount: "15000", currency: "USD" },
					},
					policy: "cheapest",
				}),
			})
		).json() as { id: string };

		const body = {
			quoteId: quote2.id,
			recipientId: recipient.id,
			delivery: "direct" as const,
			profile: "domestic",
			externalId: "ext-unique-1",
		};
		const p1 = await fetch(`${t.base}/v1/payments`, {
			method: "POST",
			headers: auth(a.key, { "idempotency-key": "idem-pay-1" }),
			body: JSON.stringify(body),
		});
		expect(p1.status).toBe(201);
		const payment = (await p1.json()) as { id: string };

		const replay = await fetch(`${t.base}/v1/payments`, {
			method: "POST",
			headers: auth(a.key, { "idempotency-key": "idem-pay-1" }),
			body: JSON.stringify(body),
		});
		expect(replay.status).toBe(201);
		expect(((await replay.json()) as { id: string }).id).toBe(payment.id);

		const dup = await fetch(`${t.base}/v1/payments`, {
			method: "POST",
			headers: auth(a.key, { "idempotency-key": "idem-pay-2" }),
			body: JSON.stringify({ ...body, externalId: "ext-unique-1" }),
		});
		expect(dup.status).toBe(409);

		const fund1 = await fetch(`${t.base}/v1/payments/${payment.id}/fund`, {
			method: "POST",
			headers: auth(a.key, { "idempotency-key": "idem-fund-1" }),
			body: "{}",
		});
		expect(fund1.status).toBe(200);
		expect(((await fund1.json()) as { status: string }).status).toBe("paid");

		const fundReplay = await fetch(`${t.base}/v1/payments/${payment.id}/fund`, {
			method: "POST",
			headers: auth(a.key, { "idempotency-key": "idem-fund-1" }),
			body: "{}",
		});
		expect(fundReplay.status).toBe(200);
		expect(((await fundReplay.json()) as { id: string }).id).toBe(payment.id);

		const cross = await fetch(`${t.base}/v1/payments/${payment.id}`, {
			headers: auth(b.key),
		});
		expect(cross.status).toBe(404);

		const eventsB = await fetch(`${t.base}/v1/events`, { headers: auth(b.key) });
		expect(eventsB.status).toBe(200);
		const ev = (await eventsB.json()) as { events: { paymentId: string | null }[] };
		expect(ev.events.every((e) => e.paymentId !== payment.id)).toBe(true);
	});
});
