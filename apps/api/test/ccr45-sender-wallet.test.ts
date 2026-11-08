import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { BlindPayAdapter, type FetchLike } from "@flexipay/adapters-live";
import type { Provider } from "@flexipay/domain";
import { verifyBlindpaySignature } from "../src/blindpay/signature.ts";
import { auth, startTestServer, type TestServer } from "./helpers.ts";

const ROW: Provider = {
	id: "blindpay_sandbox",
	kind: "bank",
	countries: ["BR", "MX", "CO", "AR"],
	currencies: ["USDC", "BRL", "MXN", "COP", "ARS"],
	endpointTypes: ["bank_account"],
	legKinds: ["convert", "payout"],
	fee: { fixed: { amount: "0", currency: "USDC" }, bps: 0 },
	fxSpreadBps: 0,
	estimatedTimeSeconds: 600,
	limits: null,
	simulated: true,
	placeholder: false,
	implementation: "blindpay",
};

const KYC = {
	email: "sender@example.test",
	first_name: "Ada",
	last_name: "Sender",
	date_of_birth: "1990-01-01T00:00:00Z",
	tax_id: "123456789",
	address_line_1: "1 Market",
	city: "Dover",
	state_province_region: "DE",
	postal_code: "19901",
	country: "US",
	id_doc_country: "US",
	id_doc_type: "PASSPORT",
	id_doc_front_file: "https://example.test/passport.jpg",
	selfie_file: "https://example.test/selfie.jpg",
};

function fakeBlindPay() {
	const calls: { method: string; path: string; body: unknown }[] = [];
	let payoutStatus = "processing";
	const fetch: FetchLike = async (url, init) => {
		const path = new URL(url).pathname;
		const body = init.body ? JSON.parse(init.body) : undefined;
		calls.push({ method: init.method, path, body });
		const reply = (status: number, json: unknown) => ({
			status,
			text: async () => JSON.stringify(json),
		});
		if (path === "/v1/instances/in_test") return reply(200, { type: "development" });
		if (path.endsWith("/tos")) {
			return reply(200, {
				url: "https://app.blindpay.com/e/terms-of-service?session_token=test",
			});
		}
		if (path.endsWith("/customers") && init.method === "POST") {
			expect(body.tax_id).toBe(KYC.tax_id);
			expect(body.tos_id).toBe("to_test");
			expect(body.type).toBe("individual");
			return reply(200, { id: "re_sender", kyc_status: "approved" });
		}
		if (path.endsWith("/customers/re_sender")) {
			return reply(200, { id: "re_sender", kyc_status: "approved" });
		}
		if (path.endsWith("/quotes/fx")) {
			return reply(200, { result_amount: 50000, blindpay_quotation: 5 });
		}
		if (path.endsWith("/bank-accounts")) return reply(200, { id: "ba_sender" });
		if (path.endsWith("/quotes")) {
			return reply(200, { id: `qu_${calls.length}`, expires_at: Date.now() + 5 * 60_000 });
		}
		if (path.endsWith("/prepare-delegate-solana")) {
			return reply(200, { transaction: "AQAAA" });
		}
		if (path.endsWith("/payouts/solana")) {
			return reply(200, { id: "pa_sol", status: "processing" });
		}
		if (path.endsWith("/payouts/pa_sol")) {
			return reply(200, { id: "pa_sol", status: payoutStatus });
		}
		return reply(500, { message: `unexpected ${path}` });
	};
	return {
		calls,
		fetch,
		setStatus(status: string) {
			payoutStatus = status;
		},
	};
}

describe("CCR-45 sender wallet BlindPay", () => {
	let s: TestServer;
	let key = "";
	let orgId = "";
	const fake = fakeBlindPay();
	const owner = Keypair.generate().publicKey.toBase58();

	beforeAll(async () => {
		s = await startTestServer();
		const org = await s.newOrg("Sender");
		key = org.key;
		orgId = org.orgId;
		await s.db.organization.update({
			where: { id: orgId },
			data: { kind: "individual" },
		});
		const adapter = new BlindPayAdapter(ROW, {
			apiKey: "bp_test",
			instanceId: "in_test",
			sandbox: null,
			liveApproved: false,
			fetch: fake.fetch,
		});
		const original = s.runtime.getProvider;
		s.runtime.getProvider = (id) =>
			id === "blindpay_sandbox" ? adapter : original(id);
	}, 60_000);

	afterAll(async () => {
		await s?.stop();
	});

	async function post(path: string, body: unknown, idem?: string) {
		const res = await fetch(`${s.base}${path}`, {
			method: "POST",
			headers: auth(key, idem ? { "idempotency-key": idem } : {}),
			body: JSON.stringify(body),
		});
		const text = await res.text();
		return { status: res.status, json: text ? JSON.parse(text) : null };
	}

	it("refuses the quote until KYC is approved, then pays from the sender wallet", async () => {
		const refused = await post("/v1/quotes", quoteBody(), "q-refused");
		expect(refused.status).toBe(422);
		expect(refused.json.code).toBe("kyc_required");
		expect(refused.json.details.step).toBe("accept_terms");
		expect(refused.json.details.url).toContain("https://app.blindpay.com/");

		const tos = await post("/v1/blindpay/onboarding/tos", { tosId: "to_test" }, "tos-1");
		expect(tos.status).toBe(200);
		expect(tos.json.next.step).toBe("submit_kyc");

		const kyc = await post("/v1/blindpay/onboarding/kyc", KYC, "kyc-1");
		expect(kyc.status).toBe(200);
		expect(kyc.json.receiverId).toBe("re_sender");
		expect(kyc.json.next.step).toBe("approved");

		const quoted = await post("/v1/quotes", quoteBody(), "q-ok");
		expect(quoted.status).toBe(201);
		expect(quoted.json.feeMode).toBeNull();
		expect(quoted.json.route.map((leg: { rail: string }) => leg.rail)).toEqual([
			"sender_wallet_blindpay",
			"blindpay_sandbox",
		]);
		expect(quoted.json.fees.flexiPayFee.amount).toBe("0");

		const recipient = await post(
			"/v1/recipients",
			{ name: "Worker B", kind: "individual", country: "BR" },
			"rcp-1",
		);
		expect(recipient.status).toBe(201);
		const endpoint = await post(
			"/v1/endpoints",
			{
				recipientId: recipient.json.id,
				type: "bank_account",
				country: "BR",
				currency: "BRL",
				network: null,
				details: { pixKey: "worker-b@example.test", accountNumber: "1234" },
				simulated: true,
			},
			"ep-1",
		);
		expect(endpoint.status).toBe(201);

		const payment = await post(
			"/v1/payments",
			{
				quoteId: quoted.json.id,
				recipientId: recipient.json.id,
				endpointId: endpoint.json.id,
				delivery: "direct",
				profile: "one_off",
			},
			"pay-1",
		);
		expect(payment.status).toBe(201);

		const delegation = await post(
			`/v1/payments/${payment.json.id}/blindpay/delegation`,
			{ ownerAddress: owner },
			"del-1",
		);
		expect(delegation.status).toBe(200);
		expect(delegation.json.transaction).toBe("AQAAA");
		expect(delegation.json.ownerAddress).toBe(owner);
		const quoteCalls = fake.calls.filter((c) => c.path.endsWith("/quotes"));
		expect(quoteCalls.at(-1)?.body).toMatchObject({
			network: "solana_devnet",
			token: "USDB",
		});
		expect(fake.calls.some((c) => c.path.includes("payouts/evm"))).toBe(false);

		const again = await post(
			`/v1/payments/${payment.json.id}/blindpay/delegation`,
			{ ownerAddress: owner },
			"del-2",
		);
		expect(again.status).toBe(200);
		expect(again.json.quoteId).toBe(delegation.json.quoteId);

		const confirmed = await post(
			`/v1/payments/${payment.json.id}/blindpay/confirm`,
			{ signature: "sig_delegation_sender_wallet_0001" },
			"cfm-1",
		);
		expect(confirmed.status).toBe(200);
		expect(confirmed.json.status).toBe("accepted");
		expect(confirmed.json.payoutId).toBe("pa_sol");
		expect(confirmed.json.paymentStatus).toBe("processing");

		const replay = await post(
			`/v1/payments/${payment.json.id}/blindpay/confirm`,
			{ signature: "sig_delegation_sender_wallet_0001" },
			"cfm-2",
		);
		expect(replay.json).toMatchObject({ status: "accepted", payoutId: "pa_sol" });
		expect(fake.calls.filter((c) => c.path.endsWith("/payouts/solana"))).toHaveLength(1);

		const settle = await s.db.leg.findFirstOrThrow({
			where: { paymentId: payment.json.id, kind: "settle" },
		});
		expect(settle.status).toBe("succeeded");
		expect(settle.externalRef).toBeNull();
		expect(settle.releaseTxRef).toBe("sig_delegation_sender_wallet_0001");

		fake.setStatus("completed");
		process.env.BLINDPAY_WEBHOOK_SECRET = "whsec_" + Buffer.from("ccr45-webhook-secret").toString("base64");
		const payload = JSON.stringify({
			event: "payout.complete",
			data: { id: "pa_sol", status: "completed" },
		});
		const stamp = String(Math.floor(Date.now() / 1000));
		const signed = `msg_1.${stamp}.${payload}`;
		const keyBytes = Buffer.from("ccr45-webhook-secret");
		const mac = createHmac("sha256", keyBytes).update(signed).digest("base64");
		const hook = await fetch(`${s.base}/v1/webhooks/blindpay`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"svix-id": "msg_1",
				"svix-timestamp": stamp,
				"svix-signature": `v1,${mac}`,
			},
			body: payload,
		});
		expect(hook.status).toBe(200);
		const after = await s.db.payment.findUniqueOrThrow({ where: { id: payment.json.id } });
		expect(after.status).toBe("paid");

		const unsigned = await fetch(`${s.base}/v1/webhooks/blindpay`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: payload,
		});
		expect(unsigned.status).toBe(400);
	});

	it("re-quotes when the five-minute lock has expired", async () => {
		const quoted = await post("/v1/quotes", quoteBody(), "q-expire");
		expect(quoted.status, JSON.stringify(quoted.json)).toBe(201);
		const recipient = await post(
			"/v1/recipients",
			{ name: "Worker C", kind: "individual", country: "BR" },
			"rcp-2",
		);
		const endpoint = await post(
			"/v1/endpoints",
			{
				recipientId: recipient.json.id,
				type: "bank_account",
				country: "BR",
				currency: "BRL",
				network: null,
				details: { pixKey: "worker-c@example.test", accountNumber: "2345" },
				simulated: true,
			},
			"ep-2",
		);
		expect(endpoint.status, JSON.stringify(endpoint.json)).toBe(201);
		const payment = await post(
			"/v1/payments",
			{
				quoteId: quoted.json.id,
				recipientId: recipient.json.id,
				endpointId: endpoint.json.id,
				delivery: "direct",
				profile: "one_off",
			},
			"pay-2",
		);
		expect(payment.status, JSON.stringify(payment.json)).toBe(201);
		const delegation = await post(
			`/v1/payments/${payment.json.id}/blindpay/delegation`,
			{ ownerAddress: owner },
			"del-expire",
		);
		expect(delegation.status).toBe(200);
		await s.db.payment.update({
			where: { id: payment.json.id },
			data: { blindpayQuoteExpiresAt: new Date(Date.now() - 1000) },
		});
		const before = fake.calls.filter((c) => c.path.endsWith("/payouts/solana")).length;
		const confirmed = await post(
			`/v1/payments/${payment.json.id}/blindpay/confirm`,
			{ signature: "sig_old_delegation_should_not_send" },
			"cfm-expire",
		);
		expect(confirmed.status).toBe(200);
		expect(confirmed.json.status).toBe("requote");
		expect(confirmed.json.transaction).toBe("AQAAA");
		expect(fake.calls.filter((c) => c.path.endsWith("/payouts/solana"))).toHaveLength(before);
	});

	it("marks a failed payout refunded without touching the vault", async () => {
		const quoted = await post("/v1/quotes", quoteBody(), "q-fail");
		expect(quoted.status, JSON.stringify(quoted.json)).toBe(201);
		const recipient = await post(
			"/v1/recipients",
			{ name: "Worker D", kind: "individual", country: "BR" },
			"rcp-3",
		);
		const endpoint = await post(
			"/v1/endpoints",
			{
				recipientId: recipient.json.id,
				type: "bank_account",
				country: "BR",
				currency: "BRL",
				network: null,
				details: { pixKey: "worker-d@example.test", accountNumber: "3456" },
				simulated: true,
			},
			"ep-3",
		);
		const payment = await post(
			"/v1/payments",
			{
				quoteId: quoted.json.id,
				recipientId: recipient.json.id,
				endpointId: endpoint.json.id,
				delivery: "direct",
				profile: "one_off",
			},
			"pay-3",
		);
		expect(payment.status, JSON.stringify(payment.json)).toBe(201);
		await post(
			`/v1/payments/${payment.json.id}/blindpay/delegation`,
			{ ownerAddress: owner },
			"del-fail",
		);
		fake.setStatus("refunded");
		const confirmed = await post(
			`/v1/payments/${payment.json.id}/blindpay/confirm`,
			{ signature: "sig_delegation_then_refunded_0001" },
			"cfm-fail",
		);
		expect(confirmed.status).toBe(200);
		const after = await s.db.payment.findUniqueOrThrow({
			where: { id: payment.json.id },
			include: { legs: true },
		});
		expect(after.status).toBe("refunded");
		const payout = after.legs.find((leg) => leg.kind === "payout");
		expect(payout?.errorCode).toBe("returned_to_wallet");
		expect(payout?.errorMessage).toBe("returned to your wallet");
		const settle = after.legs.find((leg) => leg.kind === "settle");
		expect(settle?.externalRef).toBeNull();
	});
});

function quoteBody() {
	return {
		source: { type: "bank_account", currency: "USD", country: "US" },
		destination: {
			type: "bank_account",
			currency: "BRL",
			country: "BR",
			recipientKind: "individual",
		},
		amount: { side: "send", value: { amount: "10000", currency: "USD" } },
		policy: "cheapest",
		settleMode: "sender_wallet_blindpay",
		payout: { details: { pixKey: "worker@example.test" } },
	};
}

describe("BlindPay webhook signature", () => {
	it("accepts a fresh Svix signature and rejects a stale one", () => {
		const secret = "whsec_" + Buffer.from("ccr45-webhook-secret").toString("base64");
		const raw = Buffer.from('{"event":"payout.update"}');
		const now = 1_700_000_000_000;
		const stamp = String(Math.floor(now / 1000));
		const mac = createHmac("sha256", Buffer.from("ccr45-webhook-secret"))
			.update(`msg.${stamp}.${raw.toString("utf8")}`)
			.digest("base64");
		expect(
			verifyBlindpaySignature({
				secret,
				svixId: "msg",
				svixTimestamp: stamp,
				svixSignature: `v1,${mac}`,
				rawBody: raw,
				nowMs: now,
			}),
		).toBe(true);
		expect(
			verifyBlindpaySignature({
				secret,
				svixId: "msg",
				svixTimestamp: stamp,
				svixSignature: `v1,${mac}`,
				rawBody: raw,
				nowMs: now + 10 * 60 * 1000,
			}),
		).toBe(false);
	});
});
