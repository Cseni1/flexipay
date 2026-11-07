import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type ProviderAdapter } from "@flexipay/domain";
import {
	BlindPayAdapter,
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
	if (path.startsWith("/v1/instances/"))
		return reply(200, { type: "development" });
	return reply(500, { message: "unexpected partner call" });
};

beforeAll(async () => {
	s = await startTestServer();
	const { key: apiKey } = await s.newOrg("ops-partners");
	key = apiKey;
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
	if (!tazapayRow || !blindpayRow) throw new Error("partner rows missing");
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
	const adapters = new Map<string, ProviderAdapter>([
		["tazapay_sandbox", tazapay],
		["blindpay_sandbox", blindpay],
	]);
	const original = s.runtime.getProvider;
	s.runtime.getProvider = (id) => adapters.get(id) ?? original(id);
	s.runtime.liveProviderIds = ["tazapay_sandbox", "blindpay_sandbox"];
}, 120_000);

afterAll(async () => {
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

	it("returns partner mode, health, Tazapay balances and BlindPay instance type", async () => {
		const r = await fetch(`${s.base}/v1/ops/partners`, {
			headers: auth(key),
		});
		expect(r.status).toBe(200);
		const body = (await r.json()) as {
			partners: Array<Record<string, unknown>>;
		};
		expect(body.partners).toHaveLength(2);
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
		const text = JSON.stringify(body);
		for (const secret of [
			"tz_key_not_for_responses",
			"tz_secret_not_for_responses",
			"bnf_sandbox_not_for_responses",
			"bp_key_not_for_responses",
			"account_number",
		])
			expect(text).not.toContain(secret);
	});
});