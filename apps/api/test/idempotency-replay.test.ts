import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, startTestServer, type TestServer } from "./helpers.ts";

// HTTP Idempotency-Key on the money routes (create payment, fund, cancel): a replay returns the
// stored response and never runs the engine again; the key is scoped per organization and per
// request (method, path, body).

let t: TestServer;

beforeAll(async () => {
	t = await startTestServer();
}, 180_000);

afterAll(async () => {
	await t.stop();
});

const post = (key: string, path: string, body: unknown, idem?: string) =>
	fetch(`${t.base}${path}`, {
		method: "POST",
		headers: auth(key, idem ? { "idempotency-key": idem } : {}),
		body: JSON.stringify(body),
	});

async function domesticPayment(key: string): Promise<string> {
	const recipient = await (await post(key, "/v1/recipients", { name: "Worker A", kind: "individual", country: "US" })).json();
	const quote = await (
		await post(key, "/v1/quotes", {
			source: { type: "bank_account", currency: "USD", country: "US" },
			destination: { type: "bank_account", currency: "USD", country: "US", recipientKind: "individual" },
			amount: { side: "send", value: { amount: "10000", currency: "USD" } },
			policy: "cheapest",
		})
	).json();
	const payment = await (
		await post(key, "/v1/payments", { quoteId: quote.id, recipientId: recipient.id, delivery: "direct", profile: "one_off" })
	).json();
	return payment.id;
}

describe("Idempotency-Key replays on payment routes", () => {
	it("a replayed fund returns the stored response and runs no leg twice", async () => {
		const { key } = await t.newOrg("Idem Fund");
		const id = await domesticPayment(key);
		const first = await post(key, `/v1/payments/${id}/fund`, {}, "fund-1");
		expect(first.status).toBe(200);
		const body = await first.json();
		expect(body.status).toBe("paid");
		const events = await t.db.event.count({ where: { paymentId: id } });
		const legs = await t.db.leg.findMany({ where: { paymentId: id } });

		const replay = await post(key, `/v1/payments/${id}/fund`, {}, "fund-1");
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual(body);
		expect(await t.db.event.count({ where: { paymentId: id } })).toBe(events);
		expect(await t.db.leg.findMany({ where: { paymentId: id } })).toEqual(legs);
	});

	it("the same key on another path or with another body is a 409 conflict", async () => {
		const { key } = await t.newOrg("Idem Conflict");
		const id = await domesticPayment(key);
		expect((await post(key, `/v1/payments/${id}/cancel`, {}, "k-2")).status).toBe(200);
		const otherPath = await post(key, `/v1/payments/${id}/fund`, {}, "k-2");
		expect(otherPath.status).toBe(409);
		expect((await otherPath.json()).code).toBe("idempotency_conflict");
		// The cancelled payment was not funded by the conflicting call.
		expect((await t.db.payment.findUniqueOrThrow({ where: { id } })).status).toBe("cancelled");
	});

	it("a key is scoped to its organization: the same key in another org runs independently", async () => {
		const a = await t.newOrg("Idem Org A");
		const b = await t.newOrg("Idem Org B");
		const body = { name: "Same Name", kind: "individual", country: "US" };
		const ra = await (await post(a.key, "/v1/recipients", body, "shared-key")).json();
		const rb = await (await post(b.key, "/v1/recipients", body, "shared-key")).json();
		expect(ra.id).not.toBe(rb.id);
		expect(ra.organizationId ?? a.orgId).not.toBe(rb.organizationId ?? b.orgId);
	});

	it("a refused request is not cached: the same key can be used once the request is valid", async () => {
		const { key } = await t.newOrg("Idem Error");
		const id = await domesticPayment(key);
		await post(key, `/v1/payments/${id}/cancel`, {});
		const refused = await post(key, `/v1/payments/${id}/fund`, {}, "after-error");
		expect(refused.status).toBe(409);
		expect((await refused.json()).code).toBe("invalid_state");
		expect(await t.db.idempotencyRecord.count({ where: { key: "after-error" } })).toBe(0);
	});

	it("a replayed create returns the same payment and creates no second one", async () => {
		const { key, orgId } = await t.newOrg("Idem Create");
		const recipient = await (await post(key, "/v1/recipients", { name: "W", kind: "individual", country: "US" })).json();
		const quote = await (
			await post(key, "/v1/quotes", {
				source: { type: "bank_account", currency: "USD", country: "US" },
				destination: { type: "bank_account", currency: "USD", country: "US", recipientKind: "individual" },
				amount: { side: "send", value: { amount: "10000", currency: "USD" } },
				policy: "cheapest",
			})
		).json();
		const body = { quoteId: quote.id, recipientId: recipient.id, delivery: "direct", profile: "one_off" };
		const first = await (await post(key, "/v1/payments", body, "create-1")).json();
		const second = await (await post(key, "/v1/payments", body, "create-1")).json();
		expect(second.id).toBe(first.id);
		expect(await t.db.payment.count({ where: { organizationId: orgId } })).toBe(1);
	});

	// BUG: apps/api/src/idempotency.ts:48-76 looks the key up, runs the handler, then inserts the
	// record and swallows the unique-key error (`.catch(() => {})`). Two concurrent requests with the
	// same Idempotency-Key both miss the lookup and both run, so a client retrying a timed-out
	// POST /v1/payments can create two payments (or run fund twice). Expected: exactly one runs
	// (reserve the key first, or replay from the winner's record).
	it.fails("BUG: concurrent requests with the same Idempotency-Key create only one payment", async () => {
		const { key, orgId } = await t.newOrg("Idem Race");
		const recipient = await (await post(key, "/v1/recipients", { name: "W", kind: "individual", country: "US" })).json();
		const quote = await (
			await post(key, "/v1/quotes", {
				source: { type: "bank_account", currency: "USD", country: "US" },
				destination: { type: "bank_account", currency: "USD", country: "US", recipientKind: "individual" },
				amount: { side: "send", value: { amount: "10000", currency: "USD" } },
				policy: "cheapest",
			})
		).json();
		const body = { quoteId: quote.id, recipientId: recipient.id, delivery: "direct", profile: "one_off" };
		const results = await Promise.all(
			Array.from({ length: 4 }, () => post(key, "/v1/payments", body, "race-1").then((r) => r.json())),
		);
		expect(new Set(results.map((r) => r.id)).size).toBe(1);
		expect(await t.db.payment.count({ where: { organizationId: orgId } })).toBe(1);
	});
});
