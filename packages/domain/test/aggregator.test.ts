import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	ProviderError,
	addMoney,
	applyBps,
	buildQuote,
	convertMoney,
	loadConfig,
	money,
	subtractMoney,
	toMinor,
	type CreateQuoteRequest,
	type FlexiPayConfig,
	type FxRate,
	type LegQuoteRequest,
	type Money,
	type Provider,
	type ProviderAdapter,
	type ProviderCapabilities,
} from "../src/index.ts";

// Aggregator: the router quotes every healthy provider on a leg and keeps the best one
// (owner, 2026-11-06). One provider per leg behaves exactly as before (see routing.test.ts).

const CONFIG_DIR = fileURLToPath(new URL("../../../config", import.meta.url));

const baseConfig: FlexiPayConfig = await (async () => {
	const result = await loadConfig(CONFIG_DIR);
	if (!result.ok) throw new Error(JSON.stringify(result.issues));
	return result.config;
})();

const T0 = new Date("2026-10-23T12:00:00.000Z");
const VAULT_FEE_BPS = 100;

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


const PH_BANK_PRIMARY = "sim_bank_ph_instapay";

/** The PH corridor with extra bank payout providers added after the primary one. */
function withExtraPayouts(
	extras: Array<{ id: string; fixed: string; bps: number; limits?: Provider["limits"] }>,
): FlexiPayConfig {
	const config: FlexiPayConfig = structuredClone(baseConfig);
	const primary = config.providers.find((p) => p.id === PH_BANK_PRIMARY)!;
	for (const e of extras) {
		config.providers.push({
			...structuredClone(primary),
			id: e.id,
			fee: { fixed: { amount: e.fixed, currency: primary.fee.fixed.currency }, bps: e.bps },
			...(e.limits !== undefined ? { limits: e.limits } : {}),
		});
	}
	const corridor = config.corridors.find(
		(c) => c.to.country === "PH" && c.legsAvailable.payout.includes(PH_BANK_PRIMARY),
	)!;
	corridor.legsAvailable.payout.push(...extras.map((e) => e.id));
	return config;
}

function depsFor(config: FlexiPayConfig, down: string[] = []) {
	const providers = new Map<string, ProviderAdapter>();
	for (const row of config.providers) {
		// CCR-29: partner rows are served by @flexipay/adapters-live, not by a simulated mock.
		if (row.implementation && row.implementation !== "sim") continue;
		providers.set(row.id, mockAdapter(row, config.fxRates, down.includes(row.id) ? "down" : "up"));
	}
	return {
		config,
		getProvider: (id: string) => providers.get(id),
		vaultFeeBps: VAULT_FEE_BPS,
		settlementSimulated: true,
		now: () => T0,
		quoteId: () => "quo_test_1",
	};
}

const phBankReq: CreateQuoteRequest = {
	source: { type: "bank_account", currency: "USD", country: "US" },
	policy: "cheapest",
	feeMode: "RecipientPays",
	amount: { side: "send", value: money("10000", "USD") },
	destination: { type: "bank_account", currency: "PHP", country: "PH", recipientKind: "individual" },
};

async function quoteWith(config: FlexiPayConfig, down: string[] = []) {
	const result = await buildQuote(phBankReq, depsFor(config, down));
	if (!result.ok) throw new Error(`quote failed: ${result.reasons.join("; ")}`);
	return result.quote;
}

const payoutLeg = (q: Awaited<ReturnType<typeof quoteWith>>) =>
	q.route.find((l) => l.kind === "payout")!;

describe("aggregator: best quote per leg", () => {
	it("a single provider behaves as before", async () => {
		const q = await quoteWith(baseConfig);
		expect(payoutLeg(q).providerId).toBe(PH_BANK_PRIMARY);
		expect(q.reasons.some((r) => r.startsWith("Best payout quote"))).toBe(false);
	});

	it("picks the provider that delivers the most, and says why", async () => {
		const base = await quoteWith(baseConfig);
		const q = await quoteWith(withExtraPayouts([{ id: "agg_bank_ph_cheap", fixed: "100", bps: 10 }]));
		expect(payoutLeg(q).providerId).toBe("agg_bank_ph_cheap");
		expect(toMinor(q.expectedReceive)).toBeGreaterThan(toMinor(base.expectedReceive));
		expect(q.reasons.join(" ")).toMatch(/Best payout quote: agg_bank_ph_cheap delivers .*others: sim_bank_ph_instapay/);
	});

	it("keeps the primary when it is already the cheapest", async () => {
		const q = await quoteWith(withExtraPayouts([{ id: "agg_bank_ph_dear", fixed: "9000", bps: 300 }]));
		expect(payoutLeg(q).providerId).toBe(PH_BANK_PRIMARY);
	});

	it("does not depend on config order", async () => {
		const config = withExtraPayouts([{ id: "agg_bank_ph_cheap", fixed: "100", bps: 10 }]);
		const corridor = config.corridors.find((c) => c.legsAvailable.payout.includes("agg_bank_ph_cheap"))!;
		corridor.legsAvailable.payout.reverse();
		const q = await quoteWith(config);
		expect(payoutLeg(q).providerId).toBe("agg_bank_ph_cheap");
	});

	it("a tie keeps the provider listed first", async () => {
		const primary = baseConfig.providers.find((p) => p.id === PH_BANK_PRIMARY)!;
		const q = await quoteWith(
			withExtraPayouts([{ id: "agg_bank_ph_same", fixed: primary.fee.fixed.amount, bps: primary.fee.bps }]),
		);
		expect(payoutLeg(q).providerId).toBe(PH_BANK_PRIMARY);
	});

	it("skips a provider that is down", async () => {
		const config = withExtraPayouts([{ id: "agg_bank_ph_cheap", fixed: "100", bps: 10 }]);
		const q = await quoteWith(config, ["agg_bank_ph_cheap"]);
		expect(payoutLeg(q).providerId).toBe(PH_BANK_PRIMARY);
		expect(q.reasons.join(" ")).toContain("Provider agg_bank_ph_cheap is down");
	});

	it("falls back to the other provider when one cannot quote this amount", async () => {
		const primary = baseConfig.providers.find((p) => p.id === PH_BANK_PRIMARY)!;
		const config = withExtraPayouts([{ id: "agg_bank_ph_cheap", fixed: "100", bps: 10 }]);
		// The cheap one only accepts amounts far above this payment.
		config.providers.find((p) => p.id === "agg_bank_ph_cheap")!.limits = {
			min: money("900000000", primary.fee.fixed.currency),
			max: money("100000000000", primary.fee.fixed.currency),
		};
		const q = await quoteWith(config);
		expect(payoutLeg(q).providerId).toBe(PH_BANK_PRIMARY);
		expect(q.reasons.join(" ")).toContain("Provider agg_bank_ph_cheap could not quote payout");
	});

	it("fails with the original message when no provider can quote", async () => {
		const config = structuredClone(baseConfig);
		const row = config.providers.find((p) => p.id === PH_BANK_PRIMARY)!;
		row.limits = { min: money("900000000", row.fee.fixed.currency), max: money("100000000000", row.fee.fixed.currency) };
		const result = await buildQuote(phBankReq, depsFor(config));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reasons.join(" ")).toMatch(/below min/);
	});
});

// CCR-29: an off-ramp partner (converts and pays out in one step) competes with the plain
// convert + payout route on what the recipient receives, and always serves both legs.
describe("aggregator: off-ramp partner on the convert + payout pair", () => {
	const OFFRAMP = "blindpay_sandbox";
	const brBankReq: CreateQuoteRequest = {
		...phBankReq,
		destination: { type: "bank_account", currency: "BRL", country: "BR", recipientKind: "individual" },
	};

	/** Off-ramp mock: converts USDC to BRL at `rate` with no fee, payout passes through. */
	function offramp(rate: string): ProviderAdapter {
		const row = baseConfig.providers.find((p) => p.id === OFFRAMP)!;
		const base = mockAdapter(row, baseConfig.fxRates);
		return {
			...base,
			async quote(req: LegQuoteRequest) {
				if (req.kind === "convert") {
					if (req.amountIn.currency !== "USDC") throw new ProviderError("unsupported", "USDC only");
					return {
						providerId: OFFRAMP,
						fee: money("0", "USDC"),
						fxRate: rate,
						amountOut: convertMoney(req.amountIn, rate, req.outCurrency),
						estimatedTimeSeconds: 0,
						simulated: true as const,
					};
				}
				return {
					providerId: OFFRAMP,
					fee: money("0", req.outCurrency),
					fxRate: null,
					amountOut: req.amountIn,
					estimatedTimeSeconds: 600,
					simulated: true as const,
				};
			},
		};
	}

	async function brQuote(partner: ProviderAdapter | null) {
		const deps = depsFor(baseConfig);
		const getProvider = (id: string) => (id === OFFRAMP ? (partner ?? undefined) : deps.getProvider(id));
		const result = await buildQuote(brBankReq, { ...deps, getProvider });
		if (!result.ok) throw new Error(`quote failed: ${result.reasons.join("; ")}`);
		return result.quote;
	}

	const legOf = (q: Awaited<ReturnType<typeof brQuote>>, kind: string) => q.route.filter((l) => l.kind === kind);

	it("picks the partner for both legs when it delivers more", async () => {
		const plain = await brQuote(null);
		const q = await brQuote(offramp("6.0000000"));
		const converts = legOf(q, "convert");
		expect(converts[converts.length - 1]!.providerId).toBe(OFFRAMP);
		expect(legOf(q, "payout")[0]!.providerId).toBe(OFFRAMP);
		// The convert before settle never uses the partner.
		expect(converts[0]!.providerId).not.toBe(OFFRAMP);
		expect(toMinor(q.expectedReceive)).toBeGreaterThan(toMinor(plain.expectedReceive));
		expect(q.reasons.join(" ")).toMatch(/Best payout route: blindpay_sandbox delivers .*others: sim_fx \+ sim_bank_br_pix/);
	});

	it("keeps the plain route when the partner delivers less", async () => {
		const q = await brQuote(offramp("4.0000000"));
		expect(legOf(q, "payout")[0]!.providerId).toBe("sim_bank_br_pix");
		expect(legOf(q, "convert").every((l) => l.providerId !== OFFRAMP)).toBe(true);
	});

	it("an unregistered partner (no keys) leaves the plain route working", async () => {
		const q = await brQuote(null);
		expect(legOf(q, "payout")[0]!.providerId).toBe("sim_bank_br_pix");
	});
});
