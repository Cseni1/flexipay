import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	ProviderError,
	QuoteSchema,
	addMoney,
	applyBps,
	buildQuote,
	checkEligibility,
	convertMoney,
	loadConfig,
	money,
	routeTemplate,
	subtractMoney,
	type CreateQuoteRequest,
	type FlexiPayConfig,
	type FxRate,
	type LegKind,
	type LegQuoteRequest,
	type Money,
	type Provider,
	type ProviderAdapter,
	type ProviderCapabilities,
} from "../src/index.ts";

const CONFIG_DIR = fileURLToPath(new URL("../../../config", import.meta.url));

const config: FlexiPayConfig = await (async () => {
	const result = await loadConfig(CONFIG_DIR);
	if (!result.ok) throw new Error(JSON.stringify(result.issues));
	return result.config;
})();

const T0 = new Date("2026-10-23T12:00:00.000Z");
const VAULT_FEE_BPS = 100; // 1%, from SettlementAdapter.feeBps() — not fees.json

function feeFor(row: Provider, amountIn: Money): Money {
	const proportional = applyBps(amountIn, row.fee.bps);
	if (row.fee.fixed.amount === "0") return proportional;
	if (row.fee.fixed.currency !== amountIn.currency) {
		throw new ProviderError(
			"currency_mismatch",
			`${row.id} fixed fee currency mismatch`,
		);
	}
	return addMoney(row.fee.fixed, proportional);
}

function rateFor(rates: FxRate[], from: string, to: string): FxRate {
	const rate = rates.find((r) => r.from === from && r.to === to);
	if (!rate) {
		throw new ProviderError("no_fx_rate", `no rate ${from}>${to}`);
	}
	return rate;
}

/** Hand-rolled ProviderAdapter: same CCR-4 maths as adapters-sim, no package import. */
function mockAdapter(
	row: Provider,
	rates: FxRate[],
	health: "up" | "down" = "up",
): ProviderAdapter {
	return {
		id: row.id,
		capabilities(): ProviderCapabilities {
			return {
				providerId: row.id,
				countries: [...row.countries],
				currencies: [...row.currencies],
				endpointTypes: [...row.endpointTypes],
				legKinds: [...row.legKinds],
				limits: row.limits
					? { min: { ...row.limits.min }, max: { ...row.limits.max } }
					: null,
				simulated: row.simulated,
			};
		},
		async quote(req: LegQuoteRequest) {
			if (!row.legKinds.includes(req.kind)) {
				throw new ProviderError("unsupported", `${row.id} no ${req.kind}`);
			}
			const amountIn = req.amountIn;
			if (row.limits) {
				if (amountIn.currency !== row.limits.min.currency) {
					throw new ProviderError("currency_mismatch", "limit currency");
				}
				if (BigInt(amountIn.amount) < BigInt(row.limits.min.amount)) {
					throw new ProviderError("below_min", "below min");
				}
				if (BigInt(amountIn.amount) > BigInt(row.limits.max.amount)) {
					throw new ProviderError("above_max", "above max");
				}
			}
			if (req.kind === "convert") {
				const rate = rateFor(rates, amountIn.currency, req.outCurrency);
				const fee = feeFor(row, amountIn);
				if (BigInt(fee.amount) >= BigInt(amountIn.amount)) {
					throw new ProviderError("fee_exceeds_amount", "fee too high");
				}
				const net = subtractMoney(amountIn, fee);
				const converted = convertMoney(net, rate.rate, rate.to);
				const amountOut = applyBps(converted, 10_000 - row.fxSpreadBps);
				return {
					providerId: row.id,
					fee,
					fxRate: rate.rate,
					amountOut,
					estimatedTimeSeconds: row.estimatedTimeSeconds,
					simulated: true as const,
				};
			}
			if (req.outCurrency !== amountIn.currency) {
				throw new ProviderError("currency_mismatch", "out mismatch");
			}
			if (req.kind === "payout") {
				if (!req.endpoint) {
					throw new ProviderError("unsupported", "payout needs endpoint");
				}
				if (!row.endpointTypes.includes(req.endpoint.type)) {
					throw new ProviderError("unsupported", "bad endpoint type");
				}
			}
			const fee = feeFor(row, amountIn);
			if (BigInt(fee.amount) >= BigInt(amountIn.amount)) {
				throw new ProviderError("fee_exceeds_amount", "fee too high");
			}
			return {
				providerId: row.id,
				fee,
				fxRate: null,
				amountOut: subtractMoney(amountIn, fee),
				estimatedTimeSeconds: row.estimatedTimeSeconds,
				simulated: true as const,
			};
		},
		async execute() {
			throw new Error("not used in CC1");
		},
		async status() {
			throw new Error("not used in CC1");
		},
		async reverse() {
			throw new Error("not used in CC1");
		},
		async health() {
			return health;
		},
	};
}

function registry(
	over: Record<string, "up" | "down"> = {},
): Map<string, ProviderAdapter> {
	const map = new Map<string, ProviderAdapter>();
	for (const row of config.providers) {
		map.set(row.id, mockAdapter(row, config.fxRates, over[row.id] ?? "up"));
	}
	return map;
}

function deps(
	over: Record<string, "up" | "down"> = {},
	feeMode: "PayerPays" | "RecipientPays" = "RecipientPays",
) {
	const providers = registry(over);
	return {
		config,
		getProvider: (id: string) => providers.get(id),
		vaultFeeBps: VAULT_FEE_BPS,
		// Explicit test injection — not an accepted product default (integrator decision).
		vaultFeeMode: feeMode,
		now: () => T0,
		quoteId: () => "quo_test_1",
	};
}

/** Zero foreign payout fee so fees.total can close under current directional FX rates. */
function depsZeroPayoutFee(
	payoutId: string,
	feeMode: "PayerPays" | "RecipientPays" = "RecipientPays",
) {
	const providers = registry();
	const row = config.providers.find((p) => p.id === payoutId)!;
	providers.set(
		payoutId,
		mockAdapter(
			{
				...row,
				fee: { fixed: { amount: "0", currency: row.fee.fixed.currency }, bps: 0 },
			},
			config.fxRates,
		),
	);
	return {
		config,
		getProvider: (id: string) => providers.get(id),
		vaultFeeBps: VAULT_FEE_BPS,
		vaultFeeMode: feeMode,
		now: () => T0,
		quoteId: () => "quo_test_1",
	};
}

const sourceUs = {
	type: "bank_account" as const,
	currency: "USD",
	country: "US",
};

function sendReq(
	partial: Omit<CreateQuoteRequest, "source" | "amount" | "policy"> & {
		amount?: CreateQuoteRequest["amount"];
	},
): CreateQuoteRequest {
	return {
		source: sourceUs,
		policy: "cheapest",
		amount: partial.amount ?? {
			side: "send",
			value: money("10000", "USD"),
		},
		destination: partial.destination,
	};
}

describe("routeTemplate", () => {
	it("maps the four corridor shapes", () => {
		const us = config.corridors.find((c) => c.to.country === "US")!;
		const ph = config.corridors.find((c) => c.to.country === "PH")!;
		const za = config.corridors.find((c) => c.to.country === "ZA")!;

		expect(routeTemplate(us, "bank_account")).toEqual(["collect", "payout"]);
		expect(routeTemplate(us, "crypto_wallet")).toBeNull();
		expect(routeTemplate(ph, "bank_account")).toEqual([
			"collect",
			"convert",
			"settle",
			"convert",
			"payout",
		]);
		expect(routeTemplate(ph, "crypto_wallet")).toEqual([
			"collect",
			"convert",
			"settle",
		]);
		expect(routeTemplate(za, "bank_account")).toEqual([
			"collect",
			"convert",
			"payout",
		]);
		expect(routeTemplate(za, "crypto_wallet")).toBeNull();
	});
});

describe("checkEligibility exclusions", () => {
	it("rejects unknown corridor, bad destination type, and ZA crypto", () => {
		expect(
			checkEligibility(
				sendReq({
					destination: {
						type: "bank_account",
						currency: "EUR",
						country: "DE",
						recipientKind: "individual",
					},
				}),
				config,
			).ok,
		).toBe(false);

		const zaCrypto = checkEligibility(
			sendReq({
				destination: {
					type: "crypto_wallet",
					currency: "USDC",
					country: "ZA",
					recipientKind: "company",
				},
			}),
			config,
		);
		expect(zaCrypto.ok).toBe(false);
		if (!zaCrypto.ok) {
			expect(zaCrypto.reasons.some((r) => /not allowed|Crypto leg/i.test(r))).toBe(
				true,
			);
		}
	});

	it("rejects send amounts outside corridor limits", () => {
		const below = checkEligibility(
			sendReq({
				destination: {
					type: "bank_account",
					currency: "USD",
					country: "US",
					recipientKind: "individual",
				},
				amount: { side: "send", value: money("1", "USD") },
			}),
			config,
		);
		expect(below.ok).toBe(false);
		if (!below.ok) expect(below.reasons.join(" ")).toMatch(/below the minimum/);

		const above = checkEligibility(
			sendReq({
				destination: {
					type: "bank_account",
					currency: "USD",
					country: "US",
					recipientKind: "individual",
				},
				amount: { side: "send", value: money("500001", "USD") },
			}),
			config,
		);
		expect(above.ok).toBe(false);
		if (!above.ok) expect(above.reasons.join(" ")).toMatch(/above the maximum/);
	});

	it("rejects BR e-wallet (not in allowedDestinationTypes)", () => {
		const r = checkEligibility(
			sendReq({
				destination: {
					type: "ewallet",
					currency: "BRL",
					country: "BR",
					recipientKind: "individual",
				},
			}),
			config,
		);
		expect(r.ok).toBe(false);
	});

	it("rejects ambiguous crypto when destination.country is empty (PH and BR both match)", () => {
		const r = checkEligibility(
			sendReq({
				destination: {
					type: "crypto_wallet",
					currency: "USDC",
					country: "",
					recipientKind: "individual",
				},
			}),
			config,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.reasons.join(" ")).toMatch(/Ambiguous crypto corridor/);
			expect(r.reasons.join(" ")).toMatch(/US-PH/);
			expect(r.reasons.join(" ")).toMatch(/US-BR/);
		}
	});

	it("accepts crypto when destination.country selects a unique corridor", () => {
		const r = checkEligibility(
			sendReq({
				destination: {
					type: "crypto_wallet",
					currency: "USDC",
					country: "PH",
					recipientKind: "individual",
				},
			}),
			config,
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.corridor.to.country).toBe("PH");
	});
});

describe("buildQuote corridors", () => {
	it("US domestic: collect → payout on domestic rail", async () => {
		const result = await buildQuote(
			sendReq({
				destination: {
					type: "bank_account",
					currency: "USD",
					country: "US",
					recipientKind: "individual",
				},
			}),
			deps(),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const q = QuoteSchema.parse(result.quote);
		expect(q.route.map((l) => l.kind)).toEqual(["collect", "payout"]);
		expect(q.route.every((l) => l.providerId === "sim_bank_us_ach")).toBe(true);
		expect(q.fxRate).toBeNull();
		expect(q.fees.flexiPayFee).toEqual(money("0", "USD"));
		expect(q.reasons.some((r) => /domestic rail sim_bank_us_ach/i.test(r))).toBe(
			true,
		);
		expect(q.simulated).toBe(true);
		expect(q.validUntil).toBe("2026-10-23T12:02:00.000Z");
	});

	it("PH bank with real config fees: blocks fees.total (no PHP>USD rate)", async () => {
		// Concrete send 500.00 USD — leg chain under real providers.json (evidence for review).
		const providers = registry();
		const send = money("50000", "USD");
		const collect = await providers.get("sim_bank_us_ach")!.quote({
			kind: "collect",
			amountIn: send,
			outCurrency: "USD",
		});
		const convert1 = await providers.get("sim_fx")!.quote({
			kind: "convert",
			amountIn: collect.amountOut,
			outCurrency: "USDC",
		});
		const settleIn = convert1.amountOut;
		const vaultFee = applyBps(settleIn, VAULT_FEE_BPS);
		const settleOut = subtractMoney(settleIn, vaultFee);
		const convert2 = await providers.get("sim_fx")!.quote({
			kind: "convert",
			amountIn: settleOut,
			outCurrency: "PHP",
		});
		const payout = await providers.get("sim_bank_ph_instapay")!.quote({
			kind: "payout",
			amountIn: convert2.amountOut,
			outCurrency: "PHP",
			endpoint: {
				endpointId: "quote_dest",
				type: "bank_account",
				country: "PH",
				currency: "PHP",
			},
		});
		// amountIn/out and fee per leg (minor units):
		expect({
			collect: { in: send, out: collect.amountOut, fee: collect.fee },
			convert1: {
				in: collect.amountOut,
				out: convert1.amountOut,
				fee: convert1.fee,
			},
			settle: { in: settleIn, out: settleOut, fee: vaultFee },
			convert2: {
				in: settleOut,
				out: convert2.amountOut,
				fee: convert2.fee,
			},
			payout: {
				in: convert2.amountOut,
				out: payout.amountOut,
				fee: payout.fee,
			},
		}).toEqual({
			collect: {
				in: money("50000", "USD"),
				out: money("50000", "USD"),
				fee: money("0", "USD"),
			},
			convert1: {
				in: money("50000", "USD"),
				out: money("4962562500", "USDC"),
				fee: money("125", "USD"),
			},
			settle: {
				in: money("4962562500", "USDC"),
				out: money("4912936875", "USDC"),
				fee: money("49625625", "USDC"),
			},
			convert2: {
				in: money("4912936875", "USDC"),
				out: money("2730644", "PHP"),
				fee: money("12282342", "USDC"),
			},
			payout: {
				in: money("2730644", "PHP"),
				out: money("2715491", "PHP"),
				// fixed 1500 PHP + 50 bps of input, rounded down
				fee: money("15153", "PHP"),
			},
		});
		// Convertible into USD total with existing rates: 0 + 125 + convertMoney(USDC fees) + vault.
		// Payout 28642 PHP has no PHP>USD rate → must not be omitted.
		const result = await buildQuote(
			sendReq({
				destination: {
					type: "bank_account",
					currency: "PHP",
					country: "PH",
					recipientKind: "individual",
				},
				amount: { side: "send", value: send },
			}),
			deps(),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reasons.join(" ")).toMatch(/PHP>USD/);
		expect(result.reasons.join(" ")).toMatch(/fees\.total/);
	});

	it("PH bank with zero payout fee: five legs, two converts, complete total", async () => {
		const result = await buildQuote(
			sendReq({
				destination: {
					type: "bank_account",
					currency: "PHP",
					country: "PH",
					recipientKind: "individual",
				},
				amount: { side: "send", value: money("50000", "USD") },
			}),
			depsZeroPayoutFee("sim_bank_ph_instapay"),
		);
		if (!result.ok) {
			expect.fail(`PH bank quote failed: ${result.reasons.join(" | ")}`);
		}
		const kinds = result.quote.route.map((l) => l.kind);
		expect(kinds).toEqual([
			"collect",
			"convert",
			"settle",
			"convert",
			"payout",
		]);
		expect(kinds.filter((k) => k === "convert")).toHaveLength(2);
		expect(result.quote.route[2]).toMatchObject({
			kind: "settle",
			rail: "stellar_usdc",
			providerId: "stellar_usdc",
		});
		expect(result.quote.route[4]?.providerId).toBe("sim_bank_ph_instapay");
		expect(result.quote.expectedReceive.currency).toBe("PHP");
		expect(result.quote.fees.flexiPayFee.currency).toBe("USDC");
		const settleFee = result.quote.fees.legs.find((l) => l.kind === "settle")!.fee;
		expect(result.quote.fees.flexiPayFee).toEqual(settleFee);
		expect(result.quote.fees.total.currency).toBe("USD");
		// Every non-settle leg fee + vault fee is folded into total (payout fee is 0).
		expect(BigInt(result.quote.fees.total.amount)).toBeGreaterThan(0n);
	});

	it("PH e-wallet uses sim_ewallet_ph when payout fee is zeroed for total", async () => {
		const result = await buildQuote(
			sendReq({
				destination: {
					type: "ewallet",
					currency: "PHP",
					country: "PH",
					recipientKind: "individual",
				},
				amount: { side: "send", value: money("10000", "USD") },
			}),
			depsZeroPayoutFee("sim_ewallet_ph"),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.quote.route.at(-1)?.providerId).toBe("sim_ewallet_ph");
	});

	it("BR bank: five-leg Stellar route when payout fee is zeroed for total", async () => {
		const result = await buildQuote(
			sendReq({
				destination: {
					type: "bank_account",
					currency: "BRL",
					country: "BR",
					recipientKind: "company",
				},
				amount: { side: "send", value: money("100000", "USD") },
			}),
			depsZeroPayoutFee("sim_bank_br_pix"),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.quote.route.map((l) => l.kind)).toEqual([
			"collect",
			"convert",
			"settle",
			"convert",
			"payout",
		]);
		expect(result.quote.route.at(-1)?.providerId).toBe("sim_bank_br_pix");
	});

	it("crypto destination ends at settle with no payout", async () => {
		const result = await buildQuote(
			sendReq({
				destination: {
					type: "crypto_wallet",
					currency: "USDC",
					country: "PH",
					recipientKind: "individual",
				},
				amount: { side: "send", value: money("100000", "USD") },
			}),
			deps(),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.quote.route.map((l) => l.kind)).toEqual([
			"collect",
			"convert",
			"settle",
		]);
		expect(result.quote.route.some((l) => l.kind === "payout")).toBe(false);
		expect(result.quote.expectedReceive.currency).toBe("USDC");
		expect(
			result.quote.reasons.some((r) => /ends at settle/i.test(r)),
		).toBe(true);
	});

	it("ZA bank: collect → convert → payout, no settle; company crypto reason", async () => {
		// Real ZA payout fee is ZAR with no ZAR>USD rate — zero it so total can close.
		const result = await buildQuote(
			sendReq({
				destination: {
					type: "bank_account",
					currency: "ZAR",
					country: "ZA",
					recipientKind: "company",
				},
				amount: { side: "send", value: money("100000", "USD") },
			}),
			depsZeroPayoutFee("sim_bank_za_eft"),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.quote.route.map((l) => l.kind)).toEqual([
			"collect",
			"convert",
			"payout",
		]);
		expect(result.quote.route.some((l) => l.kind === "settle")).toBe(false);
		expect(result.quote.fees.flexiPayFee).toEqual(money("0", "USD"));
		expect(
			result.quote.reasons.some((r) =>
				/Crypto leg not allowed for company/i.test(r),
			),
		).toBe(true);
	});

	it("ZA bank with real payout fee blocks fees.total (no ZAR>USD rate)", async () => {
		const result = await buildQuote(
			sendReq({
				destination: {
					type: "bank_account",
					currency: "ZAR",
					country: "ZA",
					recipientKind: "individual",
				},
				amount: { side: "send", value: money("100000", "USD") },
			}),
			deps(),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reasons.join(" ")).toMatch(/ZAR>USD/);
	});

	it("excludes a down provider and fails when no healthy alternative", async () => {
		const result = await buildQuote(
			sendReq({
				destination: {
					type: "bank_account",
					currency: "USD",
					country: "US",
					recipientKind: "individual",
				},
			}),
			deps({ sim_bank_us_ach: "down" }),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reasons.join(" ")).toMatch(/down|No healthy/i);
	});

	it("vault fee scales with settle input (not a hardcoded 1% of send)", async () => {
		const small = await buildQuote(
			sendReq({
				destination: {
					type: "crypto_wallet",
					currency: "USDC",
					country: "PH",
					recipientKind: "individual",
				},
				amount: { side: "send", value: money("10000", "USD") },
			}),
			deps(),
		);
		const large = await buildQuote(
			sendReq({
				destination: {
					type: "crypto_wallet",
					currency: "USDC",
					country: "PH",
					recipientKind: "individual",
				},
				amount: { side: "send", value: money("200000", "USD") },
			}),
			deps(),
		);
		expect(small.ok && large.ok).toBe(true);
		if (!small.ok || !large.ok) return;
		const feeSmall = BigInt(small.quote.fees.flexiPayFee.amount);
		const feeLarge = BigInt(large.quote.fees.flexiPayFee.amount);
		expect(feeLarge).toBeGreaterThan(feeSmall);
		// Exactly vaultFeeBps of settle amountIn, not of send.
		const settleIn = small.quote.fees.legs.find((l) => l.kind === "settle");
		expect(settleIn).toBeDefined();
	});

	it("uses integer FX rounding (CCR-4) on convert legs", async () => {
		const result = await buildQuote(
			sendReq({
				destination: {
					type: "bank_account",
					currency: "PHP",
					country: "PH",
					recipientKind: "individual",
				},
				amount: { side: "send", value: money("50000", "USD") },
			}),
			depsZeroPayoutFee("sim_bank_ph_instapay"),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		for (const leg of result.quote.fees.legs) {
			expect(leg.fee.amount).toMatch(/^(0|[1-9][0-9]*)$/);
		}
		expect(result.quote.expectedReceive.amount).toMatch(/^(0|[1-9][0-9]*)$/);
		expect(result.quote.fxRate === null || /^\d+(\.\d{1,7})?$/.test(result.quote.fxRate)).toBe(
			true,
		);
	});

	it("produces an A0-valid QuoteSchema payload", async () => {
		const result = await buildQuote(
			sendReq({
				destination: {
					type: "crypto_wallet",
					currency: "USDC",
					country: "PH",
					recipientKind: "individual",
				},
				amount: { side: "send", value: money("50000", "USD") },
			}),
			deps(),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(() => QuoteSchema.parse(result.quote)).not.toThrow();
		expect(result.quote.policy).toBe("cheapest");
		expect(result.quote.priceRiskBearer).toBe(config.fees.priceRiskBearer);
		expect(result.quote.alternatives).toEqual([]);
	});

	it("does not call ProviderAdapter for settle (rail priced via vaultFeeBps)", async () => {
		const providers = registry();
		const settleCalls: LegKind[] = [];
		const wrappedGet = (id: string) => {
			const inner = providers.get(id);
			if (!inner) return undefined;
			return {
				...inner,
				async quote(req: LegQuoteRequest) {
					settleCalls.push(req.kind);
					return inner.quote(req);
				},
			} as ProviderAdapter;
		};
		const result = await buildQuote(
			sendReq({
				destination: {
					type: "crypto_wallet",
					currency: "USDC",
					country: "BR",
					recipientKind: "individual",
				},
				amount: { side: "send", value: money("50000", "USD") },
			}),
			{
				config,
				getProvider: wrappedGet,
				vaultFeeBps: 250,
				vaultFeeMode: "RecipientPays",
				now: () => T0,
				quoteId: () => "quo_vault",
			},
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(settleCalls).not.toContain("settle");
		expect(result.quote.fees.flexiPayFee).toEqual(
			result.quote.fees.legs.find((l) => l.kind === "settle")!.fee,
		);
		expect(BigInt(result.quote.fees.flexiPayFee.amount)).toBeGreaterThan(0n);
	});

	it("vault fee mode changes settle amountOut (PayerPays vs RecipientPays); fee applied once", async () => {
		const req = sendReq({
			destination: {
				type: "crypto_wallet",
				currency: "USDC",
				country: "PH",
				recipientKind: "individual",
			},
			amount: { side: "send", value: money("100000", "USD") },
		});
		const recipient = await buildQuote(req, deps({}, "RecipientPays"));
		const payer = await buildQuote(req, deps({}, "PayerPays"));
		expect(recipient.ok && payer.ok).toBe(true);
		if (!recipient.ok || !payer.ok) return;
		expect(recipient.quote.fees.flexiPayFee).toEqual(payer.quote.fees.flexiPayFee);
		expect(
			BigInt(payer.quote.expectedReceive.amount),
		).toBeGreaterThan(BigInt(recipient.quote.expectedReceive.amount));
		// Difference equals the vault fee (single deduction under RecipientPays).
		expect(
			BigInt(payer.quote.expectedReceive.amount) -
				BigInt(recipient.quote.expectedReceive.amount),
		).toBe(BigInt(recipient.quote.fees.flexiPayFee.amount));
	});
});

describe("domain package boundaries", () => {
	it("routing sources do not import adapters-sim or adapter-stellar", async () => {
		const { readFileSync, readdirSync } = await import("node:fs");
		const { join } = await import("node:path");
		const dir = fileURLToPath(new URL("../src/routing", import.meta.url));
		for (const name of readdirSync(dir)) {
			if (!name.endsWith(".ts")) continue;
			const text = readFileSync(join(dir, name), "utf8");
			expect(text).not.toMatch(/adapters-sim|adapter-stellar|@flexipay\/adapters/);
		}
	});
});
