import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ProviderAdapter } from "@flexipay/domain";
import { newId } from "../src/ids.ts";
import { verifyTazapaySignature } from "../src/tazapay/signature.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

const SECRET = "tazapay-webhook-secret";

type PayoutEvent = {
	type: string;
	id: string;
	created_at: string;
	data: { id: string; status: string };
};

function payoutEvent(
	payoutId: string,
	createdAt = new Date().toISOString(),
	type = "payout.succeeded",
	status = "succeeded",
): PayoutEvent {
	return {
		type,
		id: "evt_tazapay_1",
		created_at: createdAt,
		data: { id: payoutId, status },
	};
}

function sign(
	raw: string,
	eventId: string,
	createdAt: string,
	secret = SECRET,
): string {
	return createHmac("sha256", secret)
		.update(`${eventId}${raw}${createdAt}`)
		.digest("base64");
}

function fakeTazapay() {
	const statusCalls: string[] = [];
	const stub: ProviderAdapter = {
		id: "tazapay_sandbox",
		capabilities: () => ({
			providerId: "tazapay_sandbox",
			countries: ["KE"],
			currencies: ["KES", "USD", "GBP", "TGBP"],
			endpointTypes: ["bank_account"],
			legKinds: ["convert", "payout"],
			limits: null,
			simulated: true,
		}),
		quote: async (req) => ({
			providerId: "tazapay_sandbox",
			amountIn: req.amountIn,
			amountOut:
				req.amountIn.currency === req.outCurrency
					? req.amountIn
					: { amount: req.amountIn.amount, currency: req.outCurrency },
			fee: { amount: "0", currency: req.amountIn.currency },
			fxRate: req.amountIn.currency === req.outCurrency ? null : "1",
			estimatedTimeSeconds: 60,
			simulated: true,
		}),
		execute: async () => {
			throw new Error("execute is not used by the webhook test");
		},
		status: async (externalRef) => {
			statusCalls.push(externalRef);
			return { status: "succeeded", externalRef };
		},
		reverse: async () => {
			throw new Error("reverse is not used by the webhook test");
		},
		health: async () => "up",
	};
	return { statusCalls, stub };
}

describe("Tazapay webhook signature", () => {
	it("accepts a fresh signature and rejects stale or tampered bodies", () => {
		const payload = payoutEvent("pot_signature");
		const raw = Buffer.from(JSON.stringify(payload));
		const now = Date.parse(payload.created_at);
		const signature = sign(
			raw.toString("utf8"),
			payload.id,
			payload.created_at,
		);
		expect(
			verifyTazapaySignature({
				secret: SECRET,
				signature,
				rawBody: raw,
				eventId: payload.id,
				createdAt: payload.created_at,
				nowMs: now,
			}),
		).toBe(true);
		expect(
			verifyTazapaySignature({
				secret: SECRET,
				signature,
				rawBody: raw,
				eventId: payload.id,
				createdAt: payload.created_at,
				nowMs: now + 6 * 60_000,
			}),
		).toBe(false);
		expect(
			verifyTazapaySignature({
				secret: SECRET,
				signature,
				rawBody: Buffer.from("tampered"),
				eventId: payload.id,
				createdAt: payload.created_at,
				nowMs: now,
			}),
		).toBe(false);
	});
});

describe("CCR-47 Tazapay payout webhook", { timeout: 60_000 }, () => {
	let s: TestServer;
	let orgId = "";
	let fake: ReturnType<typeof fakeTazapay>;

	beforeAll(async () => {
		s = await startTestServer();
		const org = await s.newOrg("Tazapay webhook");
		orgId = org.orgId;
		fake = fakeTazapay();
		const original = s.runtime.getProvider.bind(s.runtime);
		s.runtime.getProvider = (id) =>
			id === "tazapay_sandbox" ? fake.stub : original(id);
		s.runtime.liveProviderIds = ["tazapay_sandbox"];
	}, 60_000);

	afterAll(async () => {
		delete process.env.TAZAPAY_WEBHOOK_SECRET;
		if (s) await s.stop();
	});

	beforeEach(() => {
		process.env.TAZAPAY_WEBHOOK_SECRET = SECRET;
		fake.statusCalls.length = 0;
	});

	async function postWebhook(
		payload: PayoutEvent,
		opts: {
			signature?: string | null;
			secret?: string;
			header?: "signature" | "webhook-signature";
		} = {},
	): Promise<Response> {
		const raw = JSON.stringify(payload);
		const signature =
			opts.signature === undefined
				? sign(raw, payload.id, payload.created_at, opts.secret ?? SECRET)
				: opts.signature;
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		if (signature !== null) headers[opts.header ?? "webhook-signature"] = signature;
		return fetch(`${s.base}/v1/webhooks/tazapay`, {
			method: "POST",
			headers,
			body: raw,
		});
	}

	async function seedKnownPayout(externalRef: string): Promise<string> {
		const recipientId = newId("rcp");
		const quoteId = newId("qte");
		const paymentId = newId("pay");
		await s.db.recipient.create({
			data: {
				id: recipientId,
				organizationId: orgId,
				name: "Tazapay recipient",
				kind: "individual",
				country: "KE",
			},
		});
		await s.db.quote.create({
			data: {
				id: quoteId,
				organizationId: orgId,
				source: { type: "bank_account", currency: "USD", country: "US" },
				destination: {
					type: "bank_account",
					currency: "KES",
					country: "KE",
					recipientKind: "individual",
				},
				amountSide: "send",
				amountValue: "10000",
				amountCurrency: "USD",
				route: [],
				fees: {},
				expectedReceive: "10000",
				receiveCurrency: "KES",
				priceRiskBearer: "payer",
				policy: "cheapest",
				validUntil: new Date(Date.now() + 60 * 60_000),
				alternatives: [],
				reasons: [],
				feeMode: null,
				simulated: true,
			},
		});
		await s.db.payment.create({
			data: {
				id: paymentId,
				organizationId: orgId,
				quoteId,
				recipientId,
				delivery: "direct",
				profile: "one_off",
				status: "processing",
			},
		});
		await s.db.leg.create({
			data: {
				id: newId("leg"),
				paymentId,
				position: 0,
				kind: "payout",
				rail: "tazapay_sandbox",
				providerId: "tazapay_sandbox",
				amountInValue: "10000",
				amountInCurrency: "KES",
				amountOutValue: "10000",
				amountOutCurrency: "KES",
				status: "processing",
				attempt: 1,
				externalRef,
				simulated: true,
			},
		});
		return paymentId;
	}

	it("returns 503 when the webhook secret is not configured", async () => {
		const previous = process.env.TAZAPAY_WEBHOOK_SECRET;
		delete process.env.TAZAPAY_WEBHOOK_SECRET;
		try {
			const res = await postWebhook(payoutEvent("pot_unconfigured"));
			expect(res.status).toBe(503);
			expect((await res.json()).code).toBe("webhook_unconfigured");
		} finally {
			if (previous === undefined) delete process.env.TAZAPAY_WEBHOOK_SECRET;
			else process.env.TAZAPAY_WEBHOOK_SECRET = previous;
		}
	});

	it("rejects missing, bad and stale signatures", async () => {
		const fresh = payoutEvent("pot_unsigned");
		const missing = await postWebhook(fresh, { signature: null });
		expect(missing.status).toBe(400);
		expect((await missing.json()).code).toBe("invalid_signature");

		const bad = await postWebhook(fresh, { signature: "AAAA" });
		expect(bad.status).toBe(400);

		const staleAt = new Date(Date.now() - 6 * 60_000).toISOString();
		const stale = await postWebhook(payoutEvent("pot_stale", staleAt));
		expect(stale.status).toBe(400);
		expect(fake.statusCalls).toEqual([]);
	});

	it("acknowledges an unknown payout id and ignores it", async () => {
		const res = await postWebhook(payoutEvent("pot_unknown"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ received: true });
		expect(fake.statusCalls).toEqual([]);
	});

	it("accepts the legacy signature header", async () => {
		const res = await postWebhook(payoutEvent("pot_legacy_header"), {
			header: "signature",
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ received: true });
	});

	it("re-checks a known payout and ignores the webhook's claimed status", async () => {
		const paymentId = await seedKnownPayout("pot_known");
		const res = await postWebhook(
			payoutEvent(
				"pot_known",
				new Date().toISOString(),
				"payout.failed",
				"failed",
			),
		);
		expect(res.status).toBe(200);
		expect(fake.statusCalls).toEqual(["pot_known"]);
		const payment = await s.db.payment.findUniqueOrThrow({
			where: { id: paymentId },
			include: { legs: true },
		});
		expect(payment.status).toBe("paid");
		expect(payment.legs.find((leg) => leg.kind === "payout")?.status).toBe(
			"succeeded",
		);
	});
});
