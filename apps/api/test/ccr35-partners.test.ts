import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type ProviderAdapter } from "@flexipay/domain";
import {
	BlindPayAdapter,
	DueAdapter,
	TazapayAdapter,
	type FetchLike,
} from "@flexipay/adapters-live";
import { auth, startTestServer, type TestServer } from "./helpers.ts";

// CCR-35: operator partner status. The route must expose availability metadata only.

let s: TestServer;
let key: string;

const reply = (status: number, data: unknown) => ({
	status,
	text: async () => JSON.stringify(data),
});

const fakePartnerApi: FetchLike = async (url) => {
	const path = new URL(url).pathname;
	if (path === "/v3/metadata/payout/bank")
		return reply(200, {
			status: "success",
			message: "",
			data: {
				payout_methods: [
					{
						country: "PH",
						currency: "PHP",
						payout_type: "local",
						required_bank_fields: ["account_number"],
						required_bank_codes: [],
					},
				],
			},
		});
	if (path === "/v3/balance")
		return reply(200, {
			status: "success",
			message: "",
			data: {
				available: [
					{ currency: "GBP", amount: "12345" },
					{ currency: "USD", amount: "500" },
				],
			},
		});
	// CCR-50: Due channels (one BRL withdrawal channel is enough for health).
	if (path === "/v1/channels")
		return reply(200, [
			{
				rail: "brl_pix",
				currencyCode: "BRL",
				type: "withdrawal",
				railSettings: { schemas: ["bank_br_pix"] },
			},
		]);
	if (path.startsWith("/v1/instances/"))
		return reply(200, { type: "development" });
	return reply(500, { message: "unexpected partner call" });
};

beforeAll(async () => {
	s = await startTestServer();
	const { key: apiKey, orgId } = await s.newOrg("ops-partners");
	key = apiKey;
	process.env.FP_OPERATOR_ORG_IDS = orgId;
	const loaded = await loadConfig(
		resolve(fileURLToPath(new URL("../../../config", import.meta.url))),
	);
	if (!loaded.ok) throw new Error("config invalid");
	const tazapayRow = loaded.config.providers.find(
		(p) => p.id === "tazapay_sandbox",
	);
	const blindpayRow = loaded.config.providers.find(
		(p) => p.id === "blindpay_sandbox",
	);
	const dueRow = loaded.config.providers.find((p) => p.id === "due_sandbox");
	if (!tazapayRow || !blindpayRow || !dueRow)
		throw new Error("partner rows missing");
	const tazapay = new TazapayAdapter(tazapayRow, {
		apiKey: "tz_key_not_for_responses",
		apiSecret: "tz_secret_not_for_responses",
		sandboxBeneficiaryId: "bnf_sandbox_not_for_responses",
		liveApproved: false,
		lowBalanceAlert: 0n,
		fetch: fakePartnerApi,
	});
	const blindpay = new BlindPayAdapter(blindpayRow, {
		apiKey: "bp_key_not_for_responses",
		instanceId: "in_ccr35",
		sandbox: null,
		liveApproved: false,
		fetch: fakePartnerApi,
	});
	const due = new DueAdapter(dueRow, {
		apiKey: "due_key_not_for_responses",
		accountId: "acct_not_for_responses",
		liveApproved: false,
		fetch: fakePartnerApi,
	});
	const adapters = new Map<string, ProviderAdapter>([
		["tazapay_sandbox", tazapay],
		["blindpay_sandbox", blindpay],
		["due_sandbox", due],
	]);
	const original = s.runtime.getProvider;
	s.runtime.getProvider = (id) => adapters.get(id) ?? original(id);
	s.runtime.liveProviderIds = [
		"tazapay_sandbox",
		"blindpay_sandbox",
		"due_sandbox",
	];
}, 120_000);

afterAll(async () => {
	delete process.env.FP_OPERATOR_ORG_IDS;
	await s?.stop();
});

describe("GET /v1/ops/partners", () => {
	it("requires an API key", async () => {
		expect((await fetch(`${s.base}/v1/ops/partners`)).status).toBe(401);
		expect(
			(
				await fetch(`${s.base}/v1/ops/partners`, {
					headers: { authorization: "Bearer nope" },
				})
			).status,
		).toBe(401);
	});

	it("is 404 for a customer org that is not an operator (FlexiPay balances stay private)", async () => {
		const { key: customerKey } = await s.newOrg("ordinary-customer");
		const r = await fetch(`${s.base}/v1/ops/partners`, { headers: auth(customerKey) });
		expect(r.status).toBe(404);
		expect(await r.text()).not.toContain("balances");
	});

	it("returns partner mode, health, Tazapay balances, BlindPay instance type and Due", async () => {
		const r = await fetch(`${s.base}/v1/ops/partners`, {
			headers: auth(key),
		});
		expect(r.status).toBe(200);
		const body = (await r.json()) as {
			partners: Array<Record<string, unknown>>;
		};
		expect(body.partners).toHaveLength(3);
		const tazapay = body.partners.find((p) => p.id === "tazapay_sandbox");
		const blindpay = body.partners.find((p) => p.id === "blindpay_sandbox");
		expect(tazapay).toEqual({
			id: "tazapay_sandbox",
			label: "Tazapay",
			mode: "sandbox",
			health: "up",
			balances: [
				{ currency: "GBP", amount: 12345 },
				{ currency: "USD", amount: 500 },
			],
		});
		expect(blindpay).toEqual({
			id: "blindpay_sandbox",
			label: "BlindPay",
			mode: "sandbox",
			health: "up",
			instanceType: "development",
		});
		expect(body.partners.find((p) => p.id === "due_sandbox")).toEqual({
			id: "due_sandbox",
			label: "Due",
			mode: "sandbox",
			health: "up",
		});
		const text = JSON.stringify(body);
		for (const secret of [
			"tz_key_not_for_responses",
			"tz_secret_not_for_responses",
			"bnf_sandbox_not_for_responses",
			"bp_key_not_for_responses",
			"due_key_not_for_responses",
			"acct_not_for_responses",
			"account_number",
		])
			expect(text).not.toContain(secret);
	});
});