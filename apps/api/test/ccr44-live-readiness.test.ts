import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
	DEFAULT_DEVNET_USDC_MINT,
	DEFAULT_MAINNET_USDC_MINT,
	loadSolanaRuntimeConfig,
} from "@flexipay/adapter-solana";
import { assertLiveMoneyStartup } from "../src/live/startup.ts";
import { auth, startTestServer } from "./helpers.ts";

const LIMITS = {
	FP_INDIVIDUAL_MAX_PAYMENT_USD: "20.00",
	FP_INDIVIDUAL_MAX_24H_USD: "30.00",
	FP_INDIVIDUAL_MAX_30D_USD: "100.00",
};

const touched = [
	"FP_SOLANA_CLUSTER",
	"FP_LIVE_MONEY",
	"FP_LIVE_PAYMENTS_ENABLED",
	"FP_INDIVIDUAL_MAX_PAYMENT_USD",
	"FP_INDIVIDUAL_MAX_24H_USD",
	"FP_INDIVIDUAL_MAX_30D_USD",
] as const;

const previous: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string | undefined>) {
	for (const key of touched) {
		if (!(key in previous)) previous[key] = process.env[key];
	}
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

afterEach(() => {
	for (const key of touched) {
		if (!(key in previous)) continue;
		if (previous[key] === undefined) delete process.env[key];
		else process.env[key] = previous[key];
	}
});

async function json(res: Response): Promise<any> {
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

describe("CCR-44 live-mode readiness", { timeout: 60_000 }, () => {
	test("startup refuses mainnet without FP_LIVE_MONEY and defaults the USDC mint", () => {
		assert.throws(
			() => assertLiveMoneyStartup({ FP_SOLANA_CLUSTER: "mainnet-beta" }),
			/FP_LIVE_MONEY=1/,
		);
		assert.throws(
			() =>
				assertLiveMoneyStartup({
					FP_SOLANA_CLUSTER: "mainnet-beta",
					FP_LIVE_MONEY: "1",
				}),
			/FP_INDIVIDUAL_MAX_PAYMENT_USD/,
		);
		assert.doesNotThrow(() =>
			assertLiveMoneyStartup({
				FP_SOLANA_CLUSTER: "mainnet-beta",
				FP_LIVE_MONEY: "1",
				...LIMITS,
			}),
		);
		assert.equal(
			loadSolanaRuntimeConfig({
				FP_SOLANA_CLUSTER: "mainnet-beta",
				FP_LIVE_MONEY: "1",
			}).usdcMint,
			DEFAULT_MAINNET_USDC_MINT,
		);
		assert.equal(loadSolanaRuntimeConfig({}).usdcMint, DEFAULT_DEVNET_USDC_MINT);
		assert.equal(loadSolanaRuntimeConfig({}).cluster, "devnet");
	});

	test("kill switch pauses new quotes and payments only in live mode", async () => {
		const api = await startTestServer();
		try {
			const { key } = await api.newOrg("CCR44 Pause");
			setEnv({
				FP_SOLANA_CLUSTER: "mainnet-beta",
				FP_LIVE_MONEY: "1",
				FP_LIVE_PAYMENTS_ENABLED: "0",
			});
			const paused = await json(
				await fetch(`${api.base}/v1/quotes`, {
					method: "POST",
					headers: auth(key, { "idempotency-key": "pause-quote" }),
					body: JSON.stringify({
						source: { type: "bank_account", currency: "USD", country: "US" },
						destination: {
							type: "bank_account",
							currency: "USD",
							country: "US",
							recipientKind: "individual",
						},
						amount: { side: "send", value: { amount: "1500", currency: "USD" } },
						policy: "cheapest",
					}),
				}),
			);
			assert.equal(paused.code, "live_payments_paused");

			const payment = await fetch(`${api.base}/v1/payments`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "pause-pay" }),
				body: JSON.stringify({
					quoteId: "quo_missing",
					recipientId: "rcp_missing",
					delivery: "direct",
					profile: "one_off",
				}),
			});
			assert.equal(payment.status, 503);
			assert.equal((await json(payment)).code, "live_payments_paused");

			const read = await fetch(`${api.base}/v1/quotes/quo_missing`, {
				headers: auth(key),
			});
			assert.equal(read.status, 404);

			setEnv({ FP_LIVE_PAYMENTS_ENABLED: undefined, FP_SOLANA_CLUSTER: "devnet" });
			const open = await fetch(`${api.base}/v1/quotes`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "pause-open" }),
				body: JSON.stringify({
					source: { type: "bank_account", currency: "USD", country: "US" },
					destination: {
						type: "bank_account",
						currency: "USD",
						country: "US",
						recipientKind: "individual",
					},
					amount: { side: "send", value: { amount: "1500", currency: "USD" } },
					policy: "cheapest",
				}),
			});
			assert.equal(open.status, 201);
		} finally {
			await api.stop();
		}
	});

	test("individual sender limits return the remaining USD allowance", async () => {
		const api = await startTestServer();
		try {
			setEnv({ ...LIMITS, FP_SOLANA_CLUSTER: "devnet", FP_LIVE_MONEY: undefined });
			const business = await api.newOrg("CCR44 Business");
			const individual = await api.newOrg("CCR44 Individual");
			await api.db.organization.update({
				where: { id: individual.orgId },
				data: { kind: "individual" },
			});

			const quoteBody = (amount: string) => ({
				source: { type: "bank_account", currency: "USD", country: "US" },
				destination: {
					type: "bank_account",
					currency: "USD",
					country: "US",
					recipientKind: "individual",
				},
				amount: { side: "send", value: { amount, currency: "USD" } },
				policy: "cheapest",
			});

			const businessQuote = await fetch(`${api.base}/v1/quotes`, {
				method: "POST",
				headers: auth(business.key, { "idempotency-key": "biz" }),
				body: JSON.stringify(quoteBody("2500")),
			});
			assert.equal(businessQuote.status, 201);

			const over = await json(
				await fetch(`${api.base}/v1/quotes`, {
					method: "POST",
					headers: auth(individual.key, { "idempotency-key": "over" }),
					body: JSON.stringify(quoteBody("2500")),
				}),
			);
			assert.equal(over.code, "limit_exceeded");
			assert.equal(over.details.remaining.payment, "2000");
			assert.equal(over.details.currency, "USD");

			const firstRes = await fetch(`${api.base}/v1/quotes`, {
				method: "POST",
				headers: auth(individual.key, { "idempotency-key": "first" }),
				body: JSON.stringify(quoteBody("1500")),
			});
			const first = await json(firstRes);
			assert.equal(firstRes.status, 201, JSON.stringify(first));

			const recipient = await json(
				await fetch(`${api.base}/v1/recipients`, {
					method: "POST",
					headers: auth(individual.key, { "idempotency-key": "rcp" }),
					body: JSON.stringify({
						name: "Worker",
						kind: "individual",
						country: "US",
					}),
				}),
			);
			const created = await fetch(`${api.base}/v1/payments`, {
				method: "POST",
				headers: auth(individual.key, { "idempotency-key": "pay" }),
				body: JSON.stringify({
					quoteId: first.id,
					recipientId: recipient.id,
					delivery: "direct",
					profile: "one_off",
				}),
			});
			assert.equal(created.status, 201);

			const windowed = await json(
				await fetch(`${api.base}/v1/quotes`, {
					method: "POST",
					headers: auth(individual.key, { "idempotency-key": "window" }),
					body: JSON.stringify(quoteBody("2000")),
				}),
			);
			assert.equal(windowed.code, "limit_exceeded");
			assert.equal(windowed.details.remaining.rolling24h, "1500");
			assert.equal(windowed.details.remaining.payment, "2000");
		} finally {
			await api.stop();
		}
	});
});
