import { Keypair } from "@solana/web3.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DUE_FUNDING_GRACE_MS, DueAdapter, type FetchLike } from "@flexipay/adapters-live";
import type { Provider } from "@flexipay/domain";
import { pollProvidersOnce } from "../src/ops/provider-poller.ts";
import { adaptersOf } from "../src/routes/blindpay.ts";
import { resetSolanaRuntimeConfigCache } from "../src/solana/runtime-config.ts";
import { setSolanaVerifyForTests } from "../src/solana/verify.ts";
import type { Ctx } from "../src/routes.ts";
import { auth, startTestServer, type TestServer } from "./helpers.ts";

// CCR-51: a Due payout funded from the sender's own Solana wallet, against a fake Due API and a
// fake Solana verifier. Nothing calls Due or Solana.

const ROW: Provider = {
	id: "due_sandbox",
	kind: "bank",
	countries: ["BR", "MX", "CO", "IN", "NG", "PH"],
	currencies: ["USDC", "TGBP", "BRL", "MXN", "COP", "INR", "NGN", "PHP"],
	endpointTypes: ["bank_account"],
	legKinds: ["convert", "payout"],
	fee: { fixed: { amount: "0", currency: "USDC" }, bps: 0 },
	fxSpreadBps: 0,
	estimatedTimeSeconds: 300,
	limits: null,
	simulated: true,
	placeholder: false,
	implementation: "due",
};

const usdcMint = Keypair.generate().publicKey.toBase58();
const fundingAddress = Keypair.generate().publicKey.toBase58();
const owner = Keypair.generate().publicKey.toBase58();
const otherWallet = Keypair.generate().publicKey.toBase58();
const EXPIRES_AT = "2099-01-01T12:00:00.000Z";

function fakeDue() {
	const calls: { method: string; path: string; body: any }[] = [];
	const status = new Map<string, string>();
	let transfers = 0;
	let refuseTransfer = false;
	const fetch: FetchLike = async (url, init) => {
		const path = new URL(url).pathname;
		const body = init.body ? JSON.parse(init.body) : undefined;
		calls.push({ method: init.method, path, body });
		const reply = (code: number, json: unknown) => ({
			status: code,
			text: async () => JSON.stringify(json),
		});
		if (path === "/v1/channels") {
			return reply(200, [
				{
					rail: "brl_pix",
					currencyCode: "BRL",
					type: "withdrawal",
					railSettings: { schemas: ["bank_br_pix"] },
					purposeCodes: {},
				},
			]);
		}
		if (path === "/v1/schemas") {
			return reply(200, [
				{
					id: "bank_br_pix",
					fields: [
						{ key: "name", required: true },
						{ key: "pixKey", required: true },
					],
				},
			]);
		}
		if (path === "/v1/transfers/quote") {
			if (body.source.amount !== "0") {
				const dst = (Number(body.source.amount) - 0.3) * 5;
				return reply(200, {
					source: { ...body.source, totalFee: "0.3" },
					destination: { ...body.destination, amount: dst.toFixed(2) },
					fxRate: 0.2,
					token: "jwt.quote",
				});
			}
			return reply(200, {
				source: { ...body.source, amount: "99.700001" },
				destination: body.destination,
				fxRate: 0.2,
				token: "jwt.quote",
			});
		}
		if (path === "/v1/recipients" && init.method === "POST") {
			return reply(200, { id: "rcp_1", details: body.details });
		}
		if (path === "/v1/wallets" && init.method === "GET") return reply(200, []);
		if (path === "/v1/wallets" && init.method === "POST") {
			return reply(200, { id: `wlt_${body.address.slice(7, 12)}`, address: body.address });
		}
		if (path === "/v1/transfers" && init.method === "POST") {
			if (refuseTransfer) {
				return reply(400, {
					message: "KYC not passed",
					code: "err_kyc_not_passed",
					httpCode: 400,
				});
			}
			transfers += 1;
			const id = `tfr_${transfers}`;
			status.set(id, "awaiting_funds");
			return reply(200, { id, status: "awaiting_funds" });
		}
		const funding = /^\/v1\/transfers\/([^/]+)\/funding_address$/.exec(path);
		if (funding) {
			return reply(200, { details: { schema: "solana", address: fundingAddress } });
		}
		const transfer = /^\/v1\/transfers\/([^/]+)$/.exec(path);
		if (transfer) {
			return reply(200, {
				id: transfer[1],
				status: status.get(transfer[1]!) ?? "awaiting_funds",
				source: { amount: "99.700001", currency: "USDC", rail: "solana-local" },
				expiresAt: EXPIRES_AT,
			});
		}
		return reply(404, { message: `unexpected ${path}`, code: "err_not_found" });
	};
	return {
		calls,
		fetch,
		setStatus: (id: string, s: string) => status.set(id, s),
		refuse: (on: boolean) => {
			refuseTransfer = on;
		},
		transfersCreated: () => calls.filter((c) => c.path === "/v1/transfers").length,
	};
}

type Verified = { payer?: string; amountMinor?: bigint; notFound?: boolean; blockTime?: number };

let verifyAs: Verified = {};

describe("CCR-51 Due payout funded from the sender's wallet", () => {
	let s: TestServer;
	let key = "";
	let otherKey = "";
	const fake = fakeDue();
	let nowMs = Date.now();

	beforeAll(async () => {
		process.env.FP_SOLANA_CLUSTER = "devnet";
		process.env.FP_SOLANA_USDC_MINT = usdcMint;
		process.env.FP_SOLANA_USDC_DECIMALS = "6";
		resetSolanaRuntimeConfigCache();
		s = await startTestServer();
		key = (await s.newOrg("Due Sender")).key;
		otherKey = (await s.newOrg("Stranger")).key;
		const adapter = new DueAdapter(ROW, {
			apiKey: "due_test",
			accountId: "acct_test",
			liveApproved: false,
			fetch: fake.fetch,
			now: () => nowMs,
		});
		const original = s.runtime.getProvider;
		s.runtime.getProvider = (id) => (id === "due_sandbox" ? adapter : original(id));
		s.runtime.now = () => new Date(nowMs);
		setSolanaVerifyForTests(async (_rpc, input) => {
			if (verifyAs.notFound) return { ok: false, reason: "not_found", message: "not yet" };
			return {
				ok: true,
				signature: input.signature,
				amountMinor: verifyAs.amountMinor ?? input.amountMinor,
				mint: input.mint,
				recipientOwner: input.recipientOwner,
				payer: verifyAs.payer ?? owner,
				slot: 1,
				blockTime: verifyAs.blockTime ?? Math.floor(nowMs / 1000),
			};
		});
	}, 60_000);

	afterEach(() => {
		verifyAs = {};
		nowMs = Date.now();
	});

	afterAll(async () => {
		setSolanaVerifyForTests(null);
		resetSolanaRuntimeConfigCache();
		delete process.env.FP_SOLANA_USDC_MINT;
		delete process.env.FP_SOLANA_USDC_DECIMALS;
		await s?.stop();
	});

	async function call(method: string, path: string, body?: unknown, as = key) {
		const res = await fetch(`${s.base}${path}`, {
			method,
			headers: auth(as, method === "POST" ? { "idempotency-key": crypto.randomUUID() } : {}),
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		const text = await res.text();
		return { status: res.status, json: text ? JSON.parse(text) : null };
	}

	const poll = () => pollProvidersOnce(s.db, adaptersOf({ runtime: s.runtime } as Ctx), () => {});

	async function newDuePayment(tag: string) {
		const quote = await call("POST", "/v1/quotes", quoteBody());
		expect(quote.status, JSON.stringify(quote.json)).toBe(201);
		const recipient = await call("POST", "/v1/recipients", {
			name: `Worker ${tag}`,
			kind: "individual",
			country: "BR",
		});
		const endpoint = await call("POST", "/v1/endpoints", {
			recipientId: recipient.json.id,
			type: "bank_account",
			country: "BR",
			currency: "BRL",
			network: null,
			details: { pixKey: `worker-${tag}@example.test`, accountNumber: "1234" },
			simulated: true,
		});
		expect(endpoint.status, JSON.stringify(endpoint.json)).toBe(201);
		const payment = await call("POST", "/v1/payments", {
			quoteId: quote.json.id,
			recipientId: recipient.json.id,
			endpointId: endpoint.json.id,
			delivery: "direct",
			profile: "one_off",
		});
		expect(payment.status, JSON.stringify(payment.json)).toBe(201);
		return { quote: quote.json, payment: payment.json };
	}

	const legsOf = (id: string) =>
		s.db.leg.findMany({ where: { paymentId: id }, orderBy: { position: "asc" } });

	it("quotes Due with no treasury, then the sender pays Due's funding address and Due pays out", async () => {
		const { quote, payment } = await newDuePayment("a");
		expect(quote.feeMode).toBeNull();
		expect(quote.route.map((l: { rail: string }) => l.rail)).toEqual([
			"sender_wallet_due",
			"due_sandbox",
		]);

		const early = await call("GET", `/v1/payments/${payment.id}/due/funding`);
		expect(early.status).toBe(409);
		expect(early.json.code).toBe("funding_not_prepared");

		const ready = await call("POST", `/v1/payments/${payment.id}/due/funding`, {
			walletAddress: owner,
		});
		expect(ready.status, JSON.stringify(ready.json)).toBe(200);
		expect(ready.json).toMatchObject({
			state: "awaiting_transfer",
			paymentStatus: "processing",
			transferId: "tfr_1",
			asset: "USDC",
			mint: usdcMint,
			decimals: 6,
			amount: "99700001",
			recipient: fundingAddress,
			senderWallet: owner,
			expiresAt: EXPIRES_AT,
			signature: null,
		});
		const created = fake.calls.find((c) => c.path === "/v1/transfers")!;
		expect(created.body.sender).toBe(`wlt_${owner.slice(0, 5)}`);
		expect(
			fake.calls.find((c) => c.path === "/v1/wallets" && c.method === "POST")?.body,
		).toEqual({ address: `solana:${owner}` });

		// Repeating it reuses the transfer; another wallet is refused.
		const again = await call("POST", `/v1/payments/${payment.id}/due/funding`, {
			walletAddress: owner,
		});
		expect(again.json.transferId).toBe("tfr_1");
		expect(again.json.reference).toBe(ready.json.reference);
		expect(fake.transfersCreated()).toBe(1);
		const other = await call("POST", `/v1/payments/${payment.id}/due/funding`, {
			walletAddress: otherWallet,
		});
		expect(other.status).toBe(409);
		expect(other.json.code).toBe("wallet_mismatch");

		const view = await call("GET", `/v1/payments/${payment.id}/due/funding`);
		expect(view.json).toEqual(again.json);

		const settleWaiting = (await legsOf(payment.id))[0]!;
		expect(settleWaiting.status).toBe("processing");
		expect(settleWaiting.externalRef).toBeNull();

		verifyAs = { notFound: true };
		const pending = await call("POST", `/v1/payments/${payment.id}/due/confirm`, {
			signature: "sig_due_sender_wallet_0000000000001",
		});
		expect(pending.status).toBe(202);
		expect(pending.json.status).toBe("pending");

		verifyAs = {};
		const confirmed = await call("POST", `/v1/payments/${payment.id}/due/confirm`, {
			signature: "sig_due_sender_wallet_0000000000001",
		});
		expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
		expect(confirmed.json).toMatchObject({
			paymentStatus: "processing",
			transferId: "tfr_1",
			signature: "sig_due_sender_wallet_0000000000001",
		});
		const [settle, payout] = await legsOf(payment.id);
		expect(settle!.status).toBe("succeeded");
		expect(settle!.releaseTxRef).toBe("sig_due_sender_wallet_0000000000001");
		expect(settle!.externalRef).toBeNull();
		expect(payout!.status).toBe("processing");
		expect(payout!.externalRef).toBe("tfr_1");
		const funded = await call("GET", `/v1/payments/${payment.id}/due/funding`);
		expect(funded.json.state).toBe("funded");

		const replay = await call("POST", `/v1/payments/${payment.id}/due/confirm`, {
			signature: "sig_due_sender_wallet_0000000000001",
		});
		expect(replay.status).toBe(200);
		const different = await call("POST", `/v1/payments/${payment.id}/due/confirm`, {
			signature: "sig_due_sender_wallet_0000000000002",
		});
		expect(different.status).toBe(409);

		fake.setStatus("tfr_1", "payment_submitted");
		await poll();
		expect((await s.db.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
			"processing",
		);
		fake.setStatus("tfr_1", "payment_processed");
		await poll();
		const paid = await s.db.payment.findUniqueOrThrow({ where: { id: payment.id } });
		expect(paid.status).toBe("paid");
		expect(paid.solanaPayer).toBeNull();
		expect(paid.solanaSettleDestination).toBeNull();
	});

	it("keeps ownership first: another organization gets 404, a non-Due payment 422", async () => {
		const { payment } = await newDuePayment("b");
		for (const [method, path, body] of [
			["GET", `/v1/payments/${payment.id}/due/funding`, undefined],
			["POST", `/v1/payments/${payment.id}/due/funding`, { walletAddress: owner }],
			["POST", `/v1/payments/${payment.id}/due/confirm`, { signature: "s".repeat(64) }],
		] as const) {
			const res = await call(method, path, body, otherKey);
			expect(res.status).toBe(404);
			expect(res.json.code).toBe("not_found");
		}
		const vaultQuote = await call("POST", "/v1/quotes", {
			...quoteBody(),
			settleMode: undefined,
			feeMode: "PayerPays",
		});
		expect(vaultQuote.status, JSON.stringify(vaultQuote.json)).toBe(201);
		const recipient = await call("POST", "/v1/recipients", {
			name: "Vault Person",
			kind: "individual",
			country: "BR",
		});
		const vaultPayment = await call("POST", "/v1/payments", {
			quoteId: vaultQuote.json.id,
			recipientId: recipient.json.id,
			delivery: "direct",
			profile: "one_off",
		});
		expect(vaultPayment.status, JSON.stringify(vaultPayment.json)).toBe(201);
		const notDue = await call("POST", `/v1/payments/${vaultPayment.json.id}/due/funding`, {
			walletAddress: owner,
		});
		expect(notDue.status).toBe(422);
		expect(notDue.json.code).toBe("invalid_quote");
		const bad = await call("POST", `/v1/payments/${payment.id}/due/funding`, {
			walletAddress: "0".repeat(40),
		});
		expect(bad.status).toBe(422);
		expect(bad.json.code).toBe("invalid_wallet");
	});

	it("refuses a transfer from another wallet or of another amount, and a reused signature", async () => {
		const { payment } = await newDuePayment("c");
		await call("POST", `/v1/payments/${payment.id}/due/funding`, { walletAddress: owner });
		verifyAs = { payer: otherWallet };
		const wrong = await call("POST", `/v1/payments/${payment.id}/due/confirm`, {
			signature: "sig_due_wrong_sender_000000000000001",
		});
		expect(wrong.status).toBe(422);
		expect(wrong.json.code).toBe("wrong_sender");
		verifyAs = { amountMinor: 99700002n };
		const more = await call("POST", `/v1/payments/${payment.id}/due/confirm`, {
			signature: "sig_due_wrong_amount_000000000000001",
		});
		expect(more.status).toBe(422);
		expect(more.json.code).toBe("amount_mismatch");
		verifyAs = { blockTime: Date.parse(EXPIRES_AT) / 1000 + 1 };
		const late = await call("POST", `/v1/payments/${payment.id}/due/confirm`, {
			signature: "sig_due_too_late_00000000000000000001",
		});
		expect(late.status).toBe(422);
		expect(late.json.code).toBe("funding_expired");
		verifyAs = {};
		const reused = await call("POST", `/v1/payments/${payment.id}/due/confirm`, {
			signature: "sig_due_sender_wallet_0000000000001",
		});
		expect(reused.status).toBe(409);
		expect(reused.json.code).toBe("signature_reused");
		const payment2 = await s.db.payment.findUniqueOrThrow({ where: { id: payment.id } });
		expect(payment2.status).toBe("processing");
	});

	it("expires an unfunded payment once Due's deadline has passed", async () => {
		const { payment } = await newDuePayment("d");
		await call("POST", `/v1/payments/${payment.id}/due/funding`, { walletAddress: owner });
		await s.db.payment.update({
			where: { id: payment.id },
			data: { dueFundingExpiresAt: new Date(Date.now() - DUE_FUNDING_GRACE_MS - 1000) },
		});
		const view = await call("GET", `/v1/payments/${payment.id}/due/funding`);
		expect(view.status).toBe(200);
		expect(view.json.state).toBe("expired");
		expect(view.json.paymentStatus).toBe("expired");
		const settle = (await legsOf(payment.id))[0]!;
		expect(settle.status).toBe("failed");
		expect(settle.errorCode).toBe("funding_expired");
		expect(settle.errorMessage).toContain("Due does not credit a late deposit");
		const confirm = await call("POST", `/v1/payments/${payment.id}/due/confirm`, {
			signature: "sig_due_after_expiry_0000000000000001",
		});
		expect(confirm.status).toBe(409);
		expect(confirm.json.code).toBe("funding_expired");
		const prepare = await call("POST", `/v1/payments/${payment.id}/due/funding`, {
			walletAddress: owner,
		});
		expect(prepare.json.state).toBe("expired");
	});

	it("explains a failed Due transfer and a refund Due sent back to the wallet", async () => {
		for (const [tag, dueStatus, paymentStatus, code] of [
			["e", "failed", "failed", "provider_down"],
			["f", "canceled", "failed", "partner_canceled"],
			["g", "refund_processed", "refunded", "returned_to_wallet"],
		] as const) {
			const { payment } = await newDuePayment(tag);
			const ready = await call("POST", `/v1/payments/${payment.id}/due/funding`, {
				walletAddress: owner,
			});
			const confirmed = await call("POST", `/v1/payments/${payment.id}/due/confirm`, {
				signature: `sig_due_${tag}_then_${dueStatus}_000000000000001`,
			});
			expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
			fake.setStatus(ready.json.transferId, dueStatus);
			await poll();
			const after = await s.db.payment.findUniqueOrThrow({
				where: { id: payment.id },
				include: { legs: true },
			});
			expect(after.status).toBe(paymentStatus);
			const payout = after.legs.find((l) => l.kind === "payout")!;
			expect(payout.errorCode).toBe(code);
			expect(payout.errorMessage).toContain(`(Due transfer ${dueStatus})`);
			// No vault or treasury action: nothing was ever locked or held.
			expect(after.legs.find((l) => l.kind === "settle")!.externalRef).toBeNull();
		}
		expect(fake.calls.filter((c) => c.path === "/v1/transfers").length).toBe(
			fake.transfersCreated(),
		);
	});

	it("keeps the payment awaiting funding when Due refuses the transfer", async () => {
		const { payment } = await newDuePayment("h");
		fake.refuse(true);
		try {
			const refused = await call("POST", `/v1/payments/${payment.id}/due/funding`, {
				walletAddress: owner,
			});
			expect(refused.status).toBe(422);
			expect(refused.json.message).toContain("err_kyc_not_passed");
		} finally {
			fake.refuse(false);
		}
		const after = await s.db.payment.findUniqueOrThrow({ where: { id: payment.id } });
		expect(after.status).toBe("awaiting_funding");
		const retry = await call("POST", `/v1/payments/${payment.id}/due/funding`, {
			walletAddress: owner,
		});
		expect(retry.status).toBe(200);
		expect(retry.json.state).toBe("awaiting_transfer");
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
		settleMode: "sender_wallet_due",
		payout: { details: { pixKey: "worker@example.test" } },
	};
}
