import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { ProviderAdapter } from "@flexipay/domain";
import { auth, startTestServer } from "./helpers.ts";

type Api = Awaited<ReturnType<typeof startTestServer>>;

async function json(res: Response): Promise<any> {
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function stubTazapay(api: Api): void {
	const stub: ProviderAdapter = {
		id: "tazapay_sandbox",
		capabilities: () => ({
			providerId: "tazapay_sandbox",
			countries: ["KE", "PH"],
			currencies: ["KES", "PHP", "TGBP", "GBP"],
			endpointTypes: ["bank_account"],
			legKinds: ["convert", "payout"],
			limits: null,
			simulated: true,
		}),
		payoutRequirements: async () => ({
			detailKeys: ["accountNumber", "branchCode"],
			localFields: [
				"address.line1",
				"address.city",
				"address.state",
				"address.postal_code",
			],
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
			throw new Error("not used");
		},
		status: async (externalRef) => ({ status: "succeeded", externalRef }),
		reverse: async () => {
			throw new Error("not used");
		},
		health: async () => "up",
	};
	const original = api.runtime.getProvider.bind(api.runtime);
	api.runtime.getProvider = (id) =>
		id === "tazapay_sandbox" ? stub : original(id);
	api.runtime.liveProviderIds = ["tazapay_sandbox"];
}

describe("CCR-43 recipient address", { timeout: 60_000 }, () => {
	test("stores an optional address and rejects a mismatched country", async () => {
		const api = await startTestServer();
		try {
			const { key } = await api.newOrg("CCR43 Address");
			const created = await json(
				await fetch(`${api.base}/v1/recipients`, {
					method: "POST",
					headers: auth(key, { "idempotency-key": "addr-1" }),
					body: JSON.stringify({
						name: "Worker KE",
						kind: "individual",
						country: "KE",
						address: {
							line1: "1 Market Street",
							city: "Nairobi",
							state: "Nairobi",
							postalCode: "00100",
							country: "KE",
						},
					}),
				}),
			);
			assert.equal(created.address.line1, "1 Market Street");
			assert.equal(created.address.postalCode, "00100");
			assert.equal(created.address.country, "KE");
			assert.equal(created.address.line2, null);

			const listed = await json(
				await fetch(`${api.base}/v1/recipients`, { headers: auth(key) }),
			);
			assert.equal(listed.recipients[0].address.city, "Nairobi");

			const bare = await json(
				await fetch(`${api.base}/v1/recipients`, {
					method: "POST",
					headers: auth(key, { "idempotency-key": "addr-2" }),
					body: JSON.stringify({
						name: "No Address",
						kind: "individual",
						country: "PH",
					}),
				}),
			);
			assert.equal(bare.address, null);

			const mismatch = await fetch(`${api.base}/v1/recipients`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "addr-3" }),
				body: JSON.stringify({
					name: "Wrong",
					kind: "individual",
					country: "KE",
					address: {
						line1: "1 Market Street",
						city: "Nairobi",
						state: "Nairobi",
						postalCode: "00100",
						country: "PH",
					},
				}),
			});
			assert.equal(mismatch.status, 400);
		} finally {
			await api.stop();
		}
	});

	test("quote excludes Tazapay until the address and branch code are present", async () => {
		const api = await startTestServer();
		try {
			stubTazapay(api);
			const { key } = await api.newOrg("CCR43 Quote");
			const requirements = await json(
				await fetch(
					`${api.base}/v1/payout-requirements?country=KE&currency=KES`,
					{ headers: auth(key) },
				),
			);
			assert.equal(requirements.providerId, "tazapay_sandbox");
			assert.equal(requirements.addressRequired, true);
			assert.ok(requirements.detailKeys.includes("branchCode"));

			const blocked = await json(
				await fetch(`${api.base}/v1/quotes`, {
					method: "POST",
					headers: auth(key, { "idempotency-key": "q-block" }),
					body: JSON.stringify({
						source: { type: "bank_account", currency: "GBP", country: "GB" },
						destination: {
							type: "bank_account",
							currency: "KES",
							country: "KE",
							recipientKind: "individual",
						},
						amount: { side: "send", value: { amount: "10000", currency: "GBP" } },
						policy: "cheapest",
						feeMode: "PayerPays",
						payout: { details: { accountNumber: "1234567890" } },
					}),
				}),
			);
			assert.equal(blocked.code, "not_eligible");
			const reasons = (blocked.details?.reasons ?? []).join(" ");
			assert.match(reasons, /branchCode/);
			assert.match(reasons, /address\.line1/);

			const quoted = await fetch(`${api.base}/v1/quotes`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "q-ok" }),
				body: JSON.stringify({
					source: { type: "bank_account", currency: "GBP", country: "GB" },
					destination: {
						type: "bank_account",
						currency: "KES",
						country: "KE",
						recipientKind: "individual",
					},
					amount: { side: "send", value: { amount: "10000", currency: "GBP" } },
					policy: "cheapest",
					feeMode: "PayerPays",
					payout: {
						details: { accountNumber: "1234567890", branchCode: "01" },
						address: {
							line1: "1 Market Street",
							city: "Nairobi",
							state: "Nairobi",
							postalCode: "00100",
							country: "KE",
						},
					},
				}),
			});
			const quote = await json(quoted);
			assert.equal(quoted.status, 201, JSON.stringify(quote));
			assert.equal(
				quote.route.find((l: { kind: string }) => l.kind === "payout")?.providerId,
				"tazapay_sandbox",
			);
		} finally {
			await api.stop();
		}
	});

	test("CCR-48: payment create refuses a saved recipient missing partner fields", async () => {
		const api = await startTestServer();
		try {
			stubTazapay(api);
			const { key } = await api.newOrg("CCR48 Create");
			const post = (path: string, idem: string, body: unknown) =>
				fetch(`${api.base}${path}`, {
					method: "POST",
					headers: auth(key, { "idempotency-key": idem }),
					body: JSON.stringify(body),
				});
			const quoteBody = {
				source: { type: "bank_account", currency: "GBP", country: "GB" },
				destination: {
					type: "bank_account",
					currency: "KES",
					country: "KE",
					recipientKind: "individual",
				},
				amount: { side: "send", value: { amount: "10000", currency: "GBP" } },
				policy: "cheapest",
				feeMode: "PayerPays",
				payout: {
					details: { accountNumber: "1234567890", branchCode: "01" },
					address: {
						line1: "1 Market Street",
						city: "Nairobi",
						state: "Nairobi",
						postalCode: "00100",
						country: "KE",
					},
				},
			};
			const recipientWith = async (idem: string, address?: unknown) => {
				const r = await json(
					await post("/v1/recipients", `r-${idem}`, {
						name: "Worker KE",
						kind: "individual",
						country: "KE",
						...(address ? { address } : {}),
					}),
				);
				const ep = await json(
					await post("/v1/endpoints", `e-${idem}`, {
						recipientId: r.id,
						type: "bank_account",
						country: "KE",
						currency: "KES",
						network: null,
						details: address
							? { accountNumber: "1234567890", branchCode: "01" }
							: { accountNumber: "1234567890" },
						simulated: true,
					}),
				);
				assert.ok(ep.id, JSON.stringify(ep));
				return { recipientId: r.id as string, endpointId: ep.id as string };
			};

			const q1 = await json(await post("/v1/quotes", "q48-1", quoteBody));
			assert.ok(q1.id, JSON.stringify(q1));
			const bare = await recipientWith("bare");
			const refused = await post("/v1/payments", "p48-1", {
				quoteId: q1.id,
				recipientId: bare.recipientId,
				endpointId: bare.endpointId,
				delivery: "direct",
				profile: "one_off",
			});
			const refusedBody = await json(refused);
			assert.equal(refused.status, 422, JSON.stringify(refusedBody));
			assert.equal(refusedBody.code, "recipient_incomplete");
			assert.ok(refusedBody.details.missing.includes("branchCode"));
			assert.ok(refusedBody.details.missing.includes("address.line1"));

			const full = await recipientWith("full", quoteBody.payout.address);
			const ok = await post("/v1/payments", "p48-2", {
				quoteId: q1.id,
				recipientId: full.recipientId,
				endpointId: full.endpointId,
				delivery: "direct",
				profile: "one_off",
			});
			assert.equal(ok.status, 201, JSON.stringify(await json(ok)));
		} finally {
			await api.stop();
		}
	});
});
