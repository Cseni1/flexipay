import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auth, startTestServer, type TestServer } from "./helpers.ts";

let t: TestServer;

beforeAll(async () => {
	t = await startTestServer();
}, 180_000);

afterAll(async () => {
	await t.stop();
});

// Sandbox state (sim failures, API clock) is process-wide; start every test clean.
beforeEach(async () => {
	t.runtime.clock.reset();
	t.runtime.sim?.controls.reset();
});

const json = async <T = any>(res: Response): Promise<T> => (await res.json()) as T;

const post = (key: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
	fetch(`${t.base}${path}`, {
		method: "POST",
		headers: auth(key, headers),
		body: JSON.stringify(body),
	});

const get = (key: string, path: string) => fetch(`${t.base}${path}`, { headers: auth(key) });

async function recipient(key: string, name: string, kind: string, country: string) {
	return json<{ id: string }>(await post(key, "/v1/recipients", { name, kind, country }));
}

const ENDPOINTS = {
	phEwallet: {
		type: "ewallet",
		country: "PH",
		currency: "PHP",
		network: null,
		details: { phoneNumber: "synthetic-ewallet-a-1234" },
		simulated: true,
	},
	brBank: {
		type: "bank_account",
		country: "BR",
		currency: "BRL",
		network: null,
		details: { accountNumber: "synthetic-bank-b-5678" },
		simulated: true,
	},
	usBank: {
		type: "bank_account",
		country: "US",
		currency: "USD",
		network: null,
		details: { accountNumber: "synthetic-bank-c-9012" },
		simulated: true,
	},
	crypto: {
		type: "crypto_wallet",
		country: "",
		currency: "USDC",
		network: "stellar",
		details: { address: "GDEMODEST0000000000000000000000000000000000000000000" },
		simulated: true,
	},
} as const;

async function endpoint(key: string, recipientId: string, spec: Record<string, unknown>) {
	const res = await post(key, "/v1/endpoints", { recipientId, ...spec });
	expect(res.status).toBe(201);
	return json<{ id: string; details: Record<string, string> }>(res);
}

async function quote(key: string, destination: Record<string, unknown>, send = "15000") {
	const res = await post(key, "/v1/quotes", {
		source: { type: "bank_account", currency: "USD", country: "US" },
		destination,
		amount: { side: "send", value: { amount: send, currency: "USD" } },
		policy: "cheapest",
		feeMode: "PayerPays",
	});
	expect(res.status).toBe(201);
	return json<{ id: string; validUntil: string }>(res);
}

async function claimPayment(key: string, recipientId: string, destination: Record<string, unknown>) {
	const q = await quote(key, destination);
	const res = await post(key, "/v1/payments", {
		quoteId: q.id,
		recipientId,
		delivery: "claim_link",
		profile: "one_off",
	});
	expect(res.status).toBe(201);
	const payment = await json<{ id: string; claimLink: { url: string } }>(res);
	return { paymentId: payment.id, token: payment.claimLink.url.split("/").pop()! };
}

const publicPost = (path: string, body: unknown) =>
	fetch(`${t.base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

describe("CCR-6 sandbox advance-time (API clock only)", () => {
	it("requires auth, validates the strict body, returns { now }, accumulates, and reset restores the clock", async () => {
		const { key } = await t.newOrg("Demo Platform");
		const anon = await fetch(`${t.base}/v1/sandbox/advance-time`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ seconds: 60 }),
		});
		expect(anon.status).toBe(401);

		for (const bad of [{ seconds: 0 }, { seconds: 86401 }, { seconds: 1.5 }, {}, { seconds: "60" }, { seconds: 5, extra: 1 }]) {
			const res = await post(key, "/v1/sandbox/advance-time", bad);
			expect(res.status, JSON.stringify(bad)).toBe(400);
		}

		const startedAt = Date.now();
		const first = await post(key, "/v1/sandbox/advance-time", { seconds: 3600 });
		expect(first.status).toBe(200);
		const firstBody = await json<{ now: string }>(first);
		expect(Object.keys(firstBody)).toEqual(["now"]);
		expect(Date.parse(firstBody.now) - startedAt).toBeGreaterThanOrEqual(3_600_000);
		expect(Date.parse(firstBody.now) - startedAt).toBeLessThan(3_600_000 + 10_000);

		const second = await json<{ now: string }>(
			await post(key, "/v1/sandbox/advance-time", { seconds: 60 }),
		);
		expect(Date.parse(second.now) - Date.parse(firstBody.now)).toBeGreaterThanOrEqual(59_000);

		const reset = await post(key, "/v1/sandbox/reset", {});
		expect(reset.status).toBe(200);
		expect(Math.abs(t.runtime.now().getTime() - Date.now())).toBeLessThan(5_000);
	});

	it("an expired quote cannot create a payment (422), using the API clock", async () => {
		const { key } = await t.newOrg("Demo Platform");
		const r = await recipient(key, "Worker B", "individual", "BR");
		const q = await quote(key, {
			type: "bank_account",
			currency: "BRL",
			country: "BR",
			recipientKind: "individual",
		});
		await post(key, "/v1/sandbox/advance-time", { seconds: 3600 });
		const res = await post(key, "/v1/payments", {
			quoteId: q.id,
			recipientId: r.id,
			delivery: "direct",
			profile: "one_off",
		});
		expect(res.status).toBe(422);
		expect((await json<{ code: string }>(res)).code).toBe("quote_expired");
	});
});

describe("CCR-16 endpoints", () => {
	it("creates and lists endpoints with masked details, scoped to the organization", async () => {
		const a = await t.newOrg("Demo Platform");
		const b = await t.newOrg("Other Platform");
		const workerA = await recipient(a.key, "Worker A", "individual", "PH");

		const created = await endpoint(a.key, workerA.id, ENDPOINTS.phEwallet);
		expect(created.details.phoneNumber).toBe("************1234");
		expect(JSON.stringify(created)).not.toContain("synthetic-ewallet-a");
		const crypto = await endpoint(a.key, workerA.id, ENDPOINTS.crypto);
		expect(crypto.details.address).toMatch(/^\*+[A-Z0-9]{4}$/);

		const stored = await t.db.endpoint.findUniqueOrThrow({ where: { id: created.id } });
		expect((stored.details as Record<string, string>).phoneNumber).toBe(
			"synthetic-ewallet-a-1234",
		);

		const list = await json<{ endpoints: { id: string; recipientId: string }[] }>(
			await get(a.key, "/v1/endpoints"),
		);
		expect(list.endpoints.map((e) => e.id).sort()).toEqual([created.id, crypto.id].sort());
		const other = await recipient(a.key, "Worker B", "individual", "BR");
		await endpoint(a.key, other.id, ENDPOINTS.brBank);
		const filtered = await json<{ endpoints: { recipientId: string }[] }>(
			await get(a.key, `/v1/endpoints?recipientId=${workerA.id}`),
		);
		expect(filtered.endpoints).toHaveLength(2);
		expect(filtered.endpoints.every((e) => e.recipientId === workerA.id)).toBe(true);

		// Another organization sees nothing and cannot attach to this recipient.
		const foreign = await json<{ endpoints: unknown[] }>(await get(b.key, "/v1/endpoints"));
		expect(foreign.endpoints).toEqual([]);
		const attach = await post(b.key, "/v1/endpoints", { recipientId: workerA.id, ...ENDPOINTS.phEwallet });
		expect(attach.status).toBe(404);
	});

	it("rejects the wrong detail keys, country/network rules and unknown recipients", async () => {
		const { key } = await t.newOrg("Demo Platform");
		const r = await recipient(key, "Worker A", "individual", "PH");
		const cases: Record<string, unknown>[] = [
			{ ...ENDPOINTS.phEwallet, details: { accountNumber: "x" } },
			{ ...ENDPOINTS.brBank, details: { phoneNumber: "x" } },
			{ ...ENDPOINTS.crypto, details: { address: "x", extra: "y" } },
			{ ...ENDPOINTS.crypto, country: "PH" },
			{ ...ENDPOINTS.brBank, network: "stellar" },
			{ ...ENDPOINTS.brBank, country: "" },
			{ ...ENDPOINTS.brBank, simulated: false },
			{ ...ENDPOINTS.brBank, syntheticRef: "x" },
		];
		for (const c of cases) {
			const res = await post(key, "/v1/endpoints", { recipientId: r.id, ...c });
			expect(res.status, JSON.stringify(c)).toBe(400);
		}
		const missing = await post(key, "/v1/endpoints", { recipientId: "rcp_missing", ...ENDPOINTS.brBank });
		expect(missing.status).toBe(404);
		const anon = await fetch(`${t.base}/v1/endpoints`);
		expect(anon.status).toBe(401);
	});
});

describe("CCR-18 batches (existing payment engine, no second orchestrator)", () => {
	async function threeWorkers(key: string) {
		const a = await recipient(key, "Worker A", "individual", "PH");
		const b = await recipient(key, "Worker B", "individual", "BR");
		const c = await recipient(key, "Worker C", "individual", "US");
		const ea = await endpoint(key, a.id, ENDPOINTS.phEwallet);
		const eb = await endpoint(key, b.id, ENDPOINTS.brBank);
		const ec = await endpoint(key, c.id, ENDPOINTS.usBank);
		const rows = (suffix: string) => [
			{ recipientId: a.id, endpointId: ea.id, amount: { amount: "15000", currency: "USD" }, externalId: `df1-${suffix}-a`, profile: "batch" },
			{ recipientId: b.id, endpointId: eb.id, amount: { amount: "20000", currency: "USD" }, externalId: `df1-${suffix}-b`, profile: "batch" },
			{ recipientId: c.id, endpointId: ec.id, amount: { amount: "5000", currency: "USD" }, externalId: `df1-${suffix}-c`, profile: "batch" },
		];
		return { a, b, c, ea, eb, ec, rows };
	}

	it("creates one payment per row, funds through the existing path, derives status, emits batch.completed once", async () => {
		const { key } = await t.newOrg("Demo Platform");
		const w = await threeWorkers(key);

		const res = await post(key, "/v1/batches", { feeMode: "PayerPays", rows: w.rows("ok") });
		expect(res.status).toBe(201);
		const batch = await json<{ id: string; status: string; paymentIds: string[]; totals: { count: number } }>(res);
		expect(batch.status).toBe("open");
		expect(batch.paymentIds).toHaveLength(3);
		expect(batch.totals).toEqual({ count: 3 });

		const fetched = await json<{ status: string; paymentIds: string[] }>(await get(key, `/v1/batches/${batch.id}`));
		expect(fetched.paymentIds).toEqual(batch.paymentIds);

		const kinds: string[][] = [];
		for (const [i, id] of batch.paymentIds.entries()) {
			const fund = await post(key, `/v1/payments/${id}/fund`, {});
			expect(fund.status).toBe(200);
			const detail = await json<{ status: string; profile: string; legs: { kind: string }[] }>(
				await get(key, `/v1/payments/${id}`),
			);
			expect(detail.status).toBe("paid");
			expect(detail.profile).toBe("batch");
			kinds.push(detail.legs.map((l) => l.kind));
			if (i === 0) {
				const mid = await json<{ status: string }>(await get(key, `/v1/batches/${batch.id}`));
				expect(mid.status).toBe("processing");
			}
		}
		// A real payment engine ran: cross-border rows settle, the US row is domestic.
		expect(kinds[0]).toEqual(["collect", "convert", "settle", "convert", "payout"]);
		expect(kinds[1]).toEqual(["collect", "convert", "settle", "convert", "payout"]);
		expect(kinds[2]).toEqual(["collect", "payout"]);

		const done = await json<{ status: string }>(await get(key, `/v1/batches/${batch.id}`));
		expect(done.status).toBe("completed");
		const events = await json<{ events: { type: string; snapshot: any }[] }>(await get(key, "/v1/events"));
		const completed = events.events.filter((e) => e.type === "batch.completed");
		expect(completed).toHaveLength(1);
		expect(completed[0]!.snapshot.batchId).toBe(batch.id);

		const rows = await t.db.payment.findMany({ where: { batchId: batch.id } });
		expect(rows.every((p) => p.profile === "batch")).toBe(true);
	});

	it("is idempotent, rejects duplicate externalIds, hides other organizations, and writes nothing for a bad row", async () => {
		const { key } = await t.newOrg("Demo Platform");
		const other = await t.newOrg("Other Platform");
		const w = await threeWorkers(key);

		const first = await post(key, "/v1/batches", { feeMode: "PayerPays", rows: w.rows("idem") }, { "idempotency-key": "batch-1" });
		const replay = await post(key, "/v1/batches", { feeMode: "PayerPays", rows: w.rows("idem") }, { "idempotency-key": "batch-1" });
		expect(first.status).toBe(201);
		expect(replay.status).toBe(201);
		const firstBody = await json<{ id: string }>(first);
		expect((await json<{ id: string }>(replay)).id).toBe(firstBody.id);
		expect(await t.db.payment.count({ where: { batchId: firstBody.id } })).toBe(3);

		const dup = await post(key, "/v1/batches", { feeMode: "PayerPays", rows: w.rows("idem") });
		expect(dup.status).toBe(409);
		expect((await json<{ code: string }>(dup)).code).toBe("duplicate_external_id");
		const repeat = w.rows("rep");
		repeat[1]!.externalId = repeat[0]!.externalId;
		expect((await post(key, "/v1/batches", { feeMode: "PayerPays", rows: repeat })).status).toBe(409);

		expect((await get(other.key, `/v1/batches/${firstBody.id}`)).status).toBe(404);
		expect((await get(key, "/v1/batches/bat_missing")).status).toBe(404);

		const batchesBefore = await t.db.batch.count();
		const paymentsBefore = await t.db.payment.count();
		const swapped = w.rows("swap");
		swapped[0]!.endpointId = w.eb.id; // endpoint of a different recipient
		expect((await post(key, "/v1/batches", { feeMode: "PayerPays", rows: swapped })).status).toBe(422);
		const tooBig = w.rows("big");
		tooBig[0]!.amount = { amount: "1", currency: "USD" }; // below the corridor minimum
		const ineligible = await post(key, "/v1/batches", { feeMode: "PayerPays", rows: tooBig });
		expect([422, 400]).toContain(ineligible.status);
		const unknown = w.rows("unk");
		unknown[2]!.recipientId = "rcp_missing";
		expect((await post(key, "/v1/batches", { feeMode: "PayerPays", rows: unknown })).status).toBe(404);
		expect(await t.db.batch.count()).toBe(batchesBefore);
		expect(await t.db.payment.count()).toBe(paymentsBefore);

		for (const body of [
			{ feeMode: "PayerPays", rows: [] },
			{ feeMode: "PayerPays", rows: w.rows("x"), extra: 1 },
			{ rows: w.rows("y") },
		]) {
			expect((await post(key, "/v1/batches", body)).status).toBe(400);
		}
	});
});

describe("claim links: fiat accept (CCR-17) and lazy expiry", () => {
	const phEwalletDest = {
		type: "ewallet",
		currency: "PHP",
		country: "PH",
		recipientKind: "individual",
	};

	it("fiat claim: fund holds the payout; accept creates the endpoint and pays; replay does not pay twice", async () => {
		const { key } = await t.newOrg("Demo Platform");
		const r = await recipient(key, "Worker A", "individual", "PH");
		const { paymentId, token } = await claimPayment(key, r.id, phEwalletDest);

		// Before funding there is nothing to pay out yet.
		const early = await publishAccept(token, ENDPOINTS.phEwallet);
		expect(early.status).toBe(409);

		expect((await post(key, `/v1/payments/${paymentId}/fund`, {})).status).toBe(200);
		const held = await t.db.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { legs: { orderBy: { position: "asc" } } } });
		expect(held.status).toBe("processing");
		expect(held.legs.map((l) => l.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded", "pending"]);
		const settle = held.legs.find((l) => l.kind === "settle")!;
		expect(settle.externalRef).toBeTruthy();
		expect(settle.lockTxRef).toBeTruthy();
		expect(settle.releaseTxRef).toBeNull();

		const view = await json<{ status: string; paymentStatus: string }>(await fetch(`${t.base}/v1/claims/${token}`));
		expect(view.status).toBe("open");
		expect(view.paymentStatus).toBe("processing");

		// A different endpoint type than the one that was quoted is refused.
		const wrong = await publishAccept(token, { ...ENDPOINTS.phEwallet, type: "bank_account", details: { accountNumber: "synthetic-x-1" } });
		expect(wrong.status).toBe(422);
		expect((await json<{ code: string }>(wrong)).code).toBe("endpoint_mismatch");
		// A crypto endpoint for a fiat claim is refused too.
		expect((await publishAccept(token, ENDPOINTS.crypto)).status).toBe(422);

		const accept = await publishAccept(token, ENDPOINTS.phEwallet);
		expect(accept.status).toBe(200);
		const accepted = await json<{ paymentStatus: string; claim: { status: string } }>(accept);
		expect(accepted.claim.status).toBe("accepted");
		expect(accepted.paymentStatus).toBe("paid");

		const paid = await t.db.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { legs: { orderBy: { position: "asc" } } } });
		expect(paid.status).toBe("paid");
		const payout = paid.legs.find((l) => l.kind === "payout")!;
		expect(payout.status).toBe("succeeded");
		expect(payout.attempt).toBe(1);
		const ep = await t.db.endpoint.findFirstOrThrow({ where: { recipientId: r.id } });
		expect((ep.details as Record<string, string>).phoneNumber).toBe("synthetic-ewallet-a-1234");
		const listed = await json<{ endpoints: { details: Record<string, string> }[] }>(await get(key, `/v1/endpoints?recipientId=${r.id}`));
		expect(listed.endpoints[0]!.details.phoneNumber).toBe("************1234");

		const events = await json<{ events: { type: string }[] }>(await get(key, "/v1/events"));
		expect(events.events.filter((e) => e.type === "claim.accepted")).toHaveLength(1);

		const replay = await publishAccept(token, ENDPOINTS.phEwallet);
		expect(replay.status).toBe(200);
		expect((await json<{ paymentStatus: string }>(replay)).paymentStatus).toBe("paid");
		const after = await t.db.leg.findUniqueOrThrow({ where: { id: payout.id } });
		expect(after.externalRef).toBe(payout.externalRef);
		expect(after.attempt).toBe(1);
		expect(await t.db.endpoint.count({ where: { recipientId: r.id } })).toBe(1);
	});

	it("fiat claim: one payout failure retries once and pays; two failures refund the vault", async () => {
		const { key } = await t.newOrg("Demo Platform");
		const r = await recipient(key, "Worker A", "individual", "PH");

		const retry = await claimPayment(key, r.id, phEwalletDest);
		await post(key, `/v1/payments/${retry.paymentId}/fund`, {});
		await post(key, "/v1/sandbox/fail-next", { providerId: "sim_ewallet_ph", count: 1 });
		const ok = await publishAccept(retry.token, ENDPOINTS.phEwallet);
		expect(ok.status).toBe(200);
		expect((await json<{ paymentStatus: string }>(ok)).paymentStatus).toBe("paid");
		const retried = await t.db.leg.findFirstOrThrow({ where: { paymentId: retry.paymentId, kind: "payout" } });
		expect(retried.attempt).toBe(2);

		const refund = await claimPayment(key, r.id, phEwalletDest);
		await post(key, `/v1/payments/${refund.paymentId}/fund`, {});
		await post(key, "/v1/sandbox/fail-next", { providerId: "sim_ewallet_ph", count: 2 });
		const failed = await publishAccept(refund.token, ENDPOINTS.phEwallet);
		expect(failed.status).toBe(200);
		expect((await json<{ paymentStatus: string }>(failed)).paymentStatus).toBe("refunded");
		const rows = await t.db.leg.findMany({ where: { paymentId: refund.paymentId } });
		const settle = rows.find((l) => l.kind === "settle")!;
		expect((await t.runtime.settlement.status(settle.externalRef!)).state).toBe("refunded");
		expect(settle.releaseTxRef).toBeTruthy();
		expect(rows.find((l) => l.kind === "payout")!.attempt).toBe(2);
	});

	it("an expired crypto claim refunds the vault lock, expires the payment, and cannot be accepted", async () => {
		const { key } = await t.newOrg("Demo Platform");
		const r = await recipient(key, "Worker A", "individual", "PH");
		const { paymentId, token } = await claimPayment(key, r.id, {
			type: "crypto_wallet",
			currency: "USDC",
			country: "PH",
			recipientKind: "individual",
		});
		await post(key, `/v1/payments/${paymentId}/fund`, {});
		expect((await json<{ status: string }>(await fetch(`${t.base}/v1/claims/${token}`))).status).toBe("open");

		await post(key, "/v1/sandbox/advance-time", { seconds: 3600 });
		const view = await json<{ status: string; paymentStatus: string }>(await fetch(`${t.base}/v1/claims/${token}`));
		expect(view.status).toBe("expired");
		expect(view.paymentStatus).toBe("refunded");

		const legs = await t.db.leg.findMany({ where: { paymentId } });
		const settle = legs.find((l) => l.kind === "settle")!;
		expect(settle.status).toBe("failed");
		expect(settle.errorCode).toBe("claim_expired");
		expect(settle.releaseTxRef).toBeTruthy();
		expect((await t.runtime.settlement.status(settle.externalRef!)).state).toBe("refunded");
		expect(legs.filter((l) => l.kind === "collect" || l.kind === "convert").every((l) => l.status === "reversed")).toBe(true);

		const accept = await publishAccept(token, ENDPOINTS.crypto);
		expect(accept.status).toBe(409);
		const events = await json<{ events: { type: string }[] }>(await get(key, "/v1/events"));
		expect(events.events.some((e) => e.type === "payment.expired")).toBe(true);
		expect(events.events.some((e) => e.type === "payment.refunded")).toBe(true);
		expect((await t.db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe("refunded");
	});

	it("an expired fiat claim reverses the held payment and refunds the lock; an unfunded one just expires", async () => {
		const { key } = await t.newOrg("Demo Platform");
		const r = await recipient(key, "Worker A", "individual", "PH");
		const funded = await claimPayment(key, r.id, phEwalletDest);
		await post(key, `/v1/payments/${funded.paymentId}/fund`, {});
		const unfunded = await claimPayment(key, r.id, phEwalletDest);

		await post(key, "/v1/sandbox/advance-time", { seconds: 3600 });
		const view = await json<{ status: string; paymentStatus: string }>(await fetch(`${t.base}/v1/claims/${funded.token}`));
		expect(view.status).toBe("expired");
		expect(view.paymentStatus).toBe("refunded");
		const payout = await t.db.leg.findFirstOrThrow({ where: { paymentId: funded.paymentId, kind: "payout" } });
		expect(payout.status).toBe("pending");

		const second = await json<{ status: string; paymentStatus: string }>(await fetch(`${t.base}/v1/claims/${unfunded.token}`));
		expect(second.status).toBe("expired");
		expect(second.paymentStatus).toBe("expired");
		expect((await publishAccept(unfunded.token, ENDPOINTS.phEwallet)).status).toBe(409);
	});
});

function publishAccept(token: string, endpoint: Record<string, unknown>) {
	return publicPost(`/v1/claims/${token}/accept`, { endpoint });
}
