import type { EndpointType, FeeMode, LegKind } from "../enums.ts";
import { isCryptoEndpoint } from "../enums.ts";
import { isSolanaSettleRail } from "../solana-assets.ts";
import {
	CURRENCY_DECIMALS,
	addMoney,
	applyBps,
	convertMoney,
	floorMinorForSolanaMint,
	money,
	subtractMoney,
	toMinor,
	type Money,
} from "../money.ts";
import type { Corridor, FlexiPayConfig, FxRate } from "../config/schemas.ts";
import type {
	EndpointRef,
	LegQuote,
	ProviderAdapter,
	RecipientAddress,
} from "../adapters.ts";
import type { FeeBreakdown, PlannedLeg } from "../api/common.ts";
import type { RouteTemplate } from "./templates.ts";
import {
	missingPartnerPayoutFields,
	partnerPayoutExclusionReason,
} from "./payout-fields.ts";

// Leg pricing through ProviderAdapter.quote and vault feeBps (ARCHITECTURE §8 step 4, CCR-4).

export interface PricedLeg {
	kind: LegKind;
	rail: string;
	providerId: string;
	simulated: boolean;
	fee: Money;
	fxRate: string | null;
	amountIn: Money;
	amountOut: Money;
	estimatedTimeSeconds: number;
}

export interface PricedRoute {
	legs: PricedLeg[];
	expectedReceive: Money;
	fees: FeeBreakdown;
	fxRate: string | null;
	estimatedTimeSeconds: number;
	exclusionReasons: string[];
	/** Losing convert + payout options as full routes, best first (Quote.alternatives). */
	alternatives: PricedAlternative[];
}

export interface PricedAlternative {
	legs: PricedLeg[];
	totalCost: Money;
	estimatedTimeSeconds: number;
	reasons: string[];
}

export type PriceFail = { ok: false; reasons: string[] };
export type PriceOk = { ok: true; priced: PricedRoute };
export type PriceResult = PriceOk | PriceFail;

export interface PriceDeps {
	config: FlexiPayConfig;
	getProvider: (id: string) => ProviderAdapter | undefined;
	/** Vault fixed fee in bps from SettlementAdapter.feeBps(); unused when the route has no settle. */
	vaultFeeBps: number;
	/**
	 * Vault lock fee mode from RULES.md / LockRequest.feeMode. Required when the template
	 * includes settle (`null` only for no-settle routes). No silent MVP default.
	 */
	vaultFeeMode: FeeMode | null;
	/**
	 * Settle-leg `simulated` from settlement **execution** mode (CCR-10), not from rail id.
	 * `FP_SETTLEMENT=mock` → true; `stellar` → false. Required when the template includes settle.
	 */
	settlementSimulated: boolean;
}

function settlementAsset(corridor: Corridor, config: FlexiPayConfig): string | undefined {
	const railId = corridor.legsAvailable.settle[0];
	if (!railId) return undefined;
	return config.settlementRails.find((r) => r.id === railId)?.asset;
}

/**
 * Whether settle USDC amounts must be floored to the Solana mint step (6 decimals).
 * Applies for `solana_usdc` and for crypto_wallet quotes that still price
 * `stellar_usdc` first but may pay on Solana after claim accept (CCR-24 / Lane B).
 */
function shouldFloorSettleForSolanaMint(
	railId: string,
	destinationType: EndpointType,
): boolean {
	return isSolanaSettleRail(railId) || isCryptoEndpoint(destinationType);
}

function rateLookup(
	rates: FxRate[],
	from: string,
	to: string,
): FxRate | undefined {
	return rates.find((r) => r.from === from && r.to === to);
}

/**
 * Convert fee money into `toCurrency` using a configured directional rate only (CCR-4: never invert).
 * Zero fees need no rate. Returns null when a positive fee cannot be expressed in `toCurrency`.
 */
function feeInCurrency(
	fee: Money,
	toCurrency: string,
	rates: FxRate[],
): Money | null {
	if (fee.currency === toCurrency) return fee;
	if (toMinor(fee) === 0n) return money(0n, toCurrency);
	const rate = rateLookup(rates, fee.currency, toCurrency);
	if (!rate) return null;
	return convertMoney(fee, rate.rate, toCurrency);
}

/**
 * Sum every charged fee into `fromCurrency` for Quote.fees.total.
 * Settle fee is counted once via flexiPayFee (not again from the settle leg row).
 * Fails if any positive fee cannot be converted — never omits a fee silently.
 */
function sumFeesTotal(
	legs: PricedLeg[],
	flexiPayFee: Money,
	fromCurrency: string,
	rates: FxRate[],
): { ok: true; total: Money } | { ok: false; reasons: string[] } {
	let total = money(0n, fromCurrency);
	for (const leg of legs) {
		if (leg.kind === "settle") continue;
		const converted = feeInCurrency(leg.fee, fromCurrency, rates);
		if (!converted) {
			return {
				ok: false,
				reasons: [
					`Cannot include ${leg.kind} fee ${leg.fee.amount} ${leg.fee.currency} (rail ${leg.rail}) in fees.total (${fromCurrency}): no configured rate ${leg.fee.currency}>${fromCurrency}. CCR-4 forbids deriving an inverse. Integrator must define Quote.fees.total aggregation for multi-currency leg fees (add directional rates, or change the total contract).`,
				],
			};
		}
		total = addMoney(total, converted);
	}
	const vaultInSend = feeInCurrency(flexiPayFee, fromCurrency, rates);
	if (!vaultInSend) {
		return {
			ok: false,
			reasons: [
				`Cannot include vault flexiPayFee ${flexiPayFee.amount} ${flexiPayFee.currency} in fees.total (${fromCurrency}): no configured rate ${flexiPayFee.currency}>${fromCurrency}.`,
			],
		};
	}
	total = addMoney(total, vaultInSend);
	return { ok: true, total };
}

function plannedFrom(leg: PricedLeg): PlannedLeg {
	return {
		kind: leg.kind,
		rail: leg.rail,
		providerId: leg.providerId,
		amountIn: leg.amountIn,
		amountOut: leg.amountOut,
		simulated: leg.simulated,
	};
}

export function toPlannedLegs(legs: PricedLeg[]): PlannedLeg[] {
	return legs.map(plannedFrom);
}

/**
 * Out-currency for each template slot, walking the send → receive chain.
 * Convert before settle goes to the settlement asset; convert after settle (or ZA) goes to dest.
 */
function outCurrenciesFor(
	template: RouteTemplate,
	corridor: Corridor,
	destCurrency: string,
	settleAsset: string | undefined,
): string[] {
	const outs: string[] = [];
	let seenSettle = false;
	for (const kind of template) {
		if (kind === "collect" || kind === "payout") {
			outs.push(
				kind === "collect" ? corridor.from.currency : destCurrency,
			);
		} else if (kind === "settle") {
			if (!settleAsset) throw new Error("settle without settlement asset");
			outs.push(settleAsset);
			seenSettle = true;
		} else {
			// convert
			if (template.includes("settle") && !seenSettle) {
				if (!settleAsset) throw new Error("convert-before-settle needs asset");
				outs.push(settleAsset);
			} else {
				outs.push(destCurrency);
			}
		}
	}
	return outs;
}

async function healthyProviders(
	ids: readonly string[],
	kind: LegKind,
	getProvider: (id: string) => ProviderAdapter | undefined,
	exclusionReasons: string[],
	/** When set, the provider must serve this endpoint type (payout / collect). */
	endpointType?: EndpointType,
	endpointCountry?: string,
): Promise<ProviderAdapter[]> {
	const healthy: ProviderAdapter[] = [];
	for (const id of ids) {
		const adapter = getProvider(id);
		if (!adapter) {
			exclusionReasons.push(`Provider ${id} is not registered`);
			continue;
		}
		const caps = adapter.capabilities();
		if (!caps.legKinds.includes(kind)) {
			exclusionReasons.push(`Provider ${id} does not serve ${kind}`);
			continue;
		}
		if (endpointType && caps.endpointTypes.length > 0) {
			if (!caps.endpointTypes.includes(endpointType)) {
				exclusionReasons.push(
					`Provider ${id} does not serve ${endpointType}`,
				);
				continue;
			}
		}
		if (endpointCountry && caps.countries.length > 0 && kind === "payout") {
			if (!caps.countries.includes(endpointCountry)) {
				exclusionReasons.push(
					`Provider ${id} does not serve country ${endpointCountry}`,
				);
				continue;
			}
		}
		const health = await adapter.health();
		if (health === "down") {
			exclusionReasons.push(`Provider ${id} is down`);
			continue;
		}
		healthy.push(adapter);
	}
	return healthy;
}

/**
 * Aggregator selection: quote every healthy provider on a leg and keep the one that
 * delivers the most out (that already nets its fee and FX spread). A tie keeps the earlier
 * provider in config order, so a corridor with one provider behaves exactly as before.
 * A provider whose quote throws is skipped with a reason; if every quote throws, the first
 * error is returned unchanged.
 */
async function bestQuote(
	candidates: readonly ProviderAdapter[],
	kind: LegKind,
	request: { kind: LegKind; amountIn: Money; outCurrency: string; endpoint?: EndpointRef },
	exclusionReasons: string[],
): Promise<
	| { ok: true; adapter: ProviderAdapter; quoted: LegQuote }
	| { ok: false; reasons: string[] }
> {
	const results: Array<{ adapter: ProviderAdapter; quoted: LegQuote }> = [];
	let firstError: string | null = null;
	for (const adapter of candidates) {
		if (kind === "payout") {
			const blocked = await excludeForPayoutFields(
				adapter,
				request.endpoint,
				exclusionReasons,
			);
			if (blocked) {
				firstError ??= blocked;
				continue;
			}
		}
		try {
			results.push({ adapter, quoted: await adapter.quote(request) });
		} catch (e) {
			const msg =
				e instanceof Error ? e.message : `Provider ${adapter.id} quote failed`;
			if (firstError === null) firstError = msg;
			if (candidates.length > 1) {
				exclusionReasons.push(`Provider ${adapter.id} could not quote ${kind}: ${msg}`);
			}
		}
	}
	if (results.length === 0) {
		return { ok: false, reasons: [firstError ?? `No ${kind} provider could quote`] };
	}
	let best = results[0]!;
	for (const r of results.slice(1)) {
		if (toMinor(r.quoted.amountOut) > toMinor(best.quoted.amountOut)) best = r;
	}
	if (results.length > 1) {
		const others = results
			.filter((r) => r !== best)
			.map((r) => `${r.adapter.id} ${r.quoted.amountOut.amount} ${r.quoted.amountOut.currency}`)
			.join(", ");
		exclusionReasons.push(
			`Best ${kind} quote: ${best.adapter.id} delivers ${best.quoted.amountOut.amount} ${best.quoted.amountOut.currency} (others: ${others})`,
		);
	}
	return { ok: true, adapter: best.adapter, quoted: best.quoted };
}

/**
 * CCR-8 PayerPays principal sizing from available settle input `A`:
 * `P = floor(A * 10000 / (10000 + bps))`, `f(P) = floor(P * bps / 10000)`,
 * guaranteed `P + f(P) ≤ A`. Remainder `A − P − f(P)` stays unlocked — not a fee.
 */
export function sizePayerPaysPrincipal(
	available: Money,
	bps: number,
): { principal: Money; fee: Money; remainder: Money } {
	if (!Number.isInteger(bps) || bps < 0) {
		throw new Error(`bps must be a non-negative integer, got ${bps}`);
	}
	const A = toMinor(available);
	const P = (A * 10_000n) / (10_000n + BigInt(bps));
	const feeMinor = (P * BigInt(bps)) / 10_000n;
	if (P + feeMinor > A) {
		throw new Error(
			`CCR-8 invariant broken: P+f(P)=${P + feeMinor} > A=${A}`,
		);
	}
	const remainderMinor = A - P - feeMinor;
	return {
		principal: money(P, available.currency),
		fee: money(feeMinor, available.currency),
		remainder: money(remainderMinor, available.currency),
	};
}

/**
 * Vault settle pricing (RULES.md / CCR-8). Fee is computed once here from vaultFeeBps;
 * provider adapters are not called for settle, so the vault fee is never double-applied
 * on top of a provider quote.
 *
 * `available` is A — the settlement-asset amount arriving from the prior leg.
 */
function priceSettle(
	available: Money,
	railId: string,
	vaultFeeBps: number,
	feeMode: FeeMode,
	settlementSimulated: boolean,
	floorForSolanaMint: boolean,
):
	| {
			ok: true;
			leg: PricedLeg;
			/** CCR-13 accounting; null when RecipientPays or remainder is zero. */
			unlockedRemainder: Money | null;
			remainderNote?: string;
	  }
	| { ok: false; error: string } {
	const applySolanaFloor =
		floorForSolanaMint &&
		(available.currency === "USDC" || available.currency === "TGBP");

	if (feeMode === "RecipientPays") {
		let fee: Money;
		try {
			fee = applyBps(available, vaultFeeBps);
		} catch (e) {
			return {
				ok: false,
				error: e instanceof Error ? e.message : "invalid vault fee bps",
			};
		}
		if (toMinor(fee) >= toMinor(available)) {
			return {
				ok: false,
				error: `Vault fee ${fee.amount} ${fee.currency} exceeds or equals settle amount (RecipientPays)`,
			};
		}
		let amountOut = subtractMoney(available, fee);
		let unlockedRemainder: Money | null = null;
		let remainderNote: string | undefined;
		// Floor net out to Solana mint step; dust stays unlocked.
		if (applySolanaFloor) {
			const floored = floorMinorForSolanaMint(toMinor(amountOut), amountOut.currency);
			if (floored !== toMinor(amountOut)) {
				if (floored <= 0n) {
					return {
						ok: false,
						error:
							`Solana ${amountOut.currency} settle net floors to zero at mint decimals`,
					};
				}
				const dust = toMinor(amountOut) - floored;
				amountOut = money(floored, available.currency);
				unlockedRemainder = money(dust, available.currency);
				remainderNote = `RecipientPays Solana ${amountOut.currency} mint floor discarded ${dust} minor units (unlocked; not a fee)`;
			}
		}
		return {
			ok: true,
			unlockedRemainder,
			remainderNote,
			leg: {
				kind: "settle",
				rail: railId,
				providerId: railId,
				simulated: settlementSimulated,
				fee,
				fxRate: null,
				amountIn: available,
				amountOut,
				estimatedTimeSeconds: 0,
			},
		};
	}

	// PayerPays (CCR-8): amountIn = P, amountOut = P, fee = f(P); remainder unlocked.
	let sized: ReturnType<typeof sizePayerPaysPrincipal>;
	try {
		sized = sizePayerPaysPrincipal(available, vaultFeeBps);
	} catch (e) {
		return {
			ok: false,
			error: e instanceof Error ? e.message : "invalid PayerPays sizing",
		};
	}

	let principal = sized.principal;
	let fee = sized.fee;
	let remainder = sized.remainder;

	// Floor FlexiPay USDC (7 dec) down to Solana mint step (6 dec).
	// Rule: P' = floor(P / 10) * 10; recompute f(P'); remainder absorbs the dust.
	// Examples: 9851485 → 9851480; 9950000 unchanged.
	if (applySolanaFloor) {
		const floored = floorMinorForSolanaMint(toMinor(principal), principal.currency);
		if (floored !== toMinor(principal)) {
			if (floored <= 0n) {
				return {
					ok: false,
					error:
						`Solana ${principal.currency} settle principal floors to zero at mint decimals`,
				};
			}
			principal = money(floored, available.currency);
			fee = money((floored * BigInt(vaultFeeBps)) / 10_000n, available.currency);
			const rem = toMinor(available) - floored - toMinor(fee);
			if (rem < 0n) {
				return {
					ok: false,
					error: `Solana ${principal.currency} settle floor broke P+f(P) ≤ A`,
				};
			}
			remainder = money(rem, available.currency);
		}
	}

	const hasRemainder = toMinor(remainder) > 0n;
	const remainderNote = hasRemainder
		? `PayerPays settle remainder ${remainder.amount} ${remainder.currency} stays unlocked (not a fee; CCR-8/CCR-13)`
		: undefined;
	return {
		ok: true,
		unlockedRemainder: hasRemainder ? remainder : null,
		leg: {
			kind: "settle",
			rail: railId,
			providerId: railId,
			simulated: settlementSimulated,
			fee,
			fxRate: null,
			amountIn: principal,
			amountOut: principal,
			estimatedTimeSeconds: 0,
		},
		remainderNote,
	};
}

/** CCR-29: a provider that converts and pays out in one step (it serves both leg kinds). */
function isOfframp(adapter: ProviderAdapter): boolean {
	const kinds = adapter.capabilities().legKinds;
	return kinds.includes("convert") && kinds.includes("payout");
}

function pricedLeg(
	kind: LegKind,
	amountIn: Money,
	adapter: ProviderAdapter,
	quoted: LegQuote,
): PricedLeg {
	return {
		kind,
		rail: adapter.id,
		providerId: adapter.id,
		// CCR-10: pass through the provider quote flag (sim adapters are true).
		simulated: quoted.simulated === true,
		fee: quoted.fee,
		fxRate: quoted.fxRate,
		amountIn,
		amountOut: quoted.amountOut,
		estimatedTimeSeconds: quoted.estimatedTimeSeconds,
	};
}

type Destination = {
	type: EndpointType;
	currency: string;
	country: string;
	/** CCR-43: present only when the quote carried a payout profile. */
	details?: Record<string, string>;
	recipientAddress?: RecipientAddress;
};

/** Drop a partner whose country requirements are not on the quote endpoint (CCR-43). */
async function excludeForPayoutFields(
	adapter: ProviderAdapter,
	endpoint: EndpointRef | undefined,
	exclusionReasons: string[],
): Promise<string | null> {
	if (!endpoint || !adapter.payoutRequirements) return null;
	let requirements;
	try {
		requirements = await adapter.payoutRequirements(endpoint.country, endpoint.currency);
	} catch (e) {
		const msg = e instanceof Error ? e.message : "payout requirements failed";
		const reason = `Provider ${adapter.id} excluded: could not read payout requirements for ${endpoint.country} (${msg})`;
		exclusionReasons.push(reason);
		return reason;
	}
	if (!requirements) return null;
	const missing = missingPartnerPayoutFields(endpoint, requirements);
	if (missing.length === 0) return null;
	const reason = partnerPayoutExclusionReason(adapter.id, endpoint.country, missing);
	exclusionReasons.push(reason);
	return reason;
}

/** Healthy candidates for one non-settle leg, plus the payout endpoint to quote against. */
async function legCandidates(
	deps: PriceDeps,
	corridor: Corridor,
	kind: LegKind,
	destination: Destination,
	exclusionReasons: string[],
): Promise<
	{ ok: true; candidates: ProviderAdapter[]; endpoint: EndpointRef | undefined } | PriceFail
> {
	// CCR-29: a partner row whose keys are not set is simply absent, not an error to report.
	let candidateIds = corridor.legsAvailable[kind].filter((id) => {
		const row = deps.config.providers.find((p) => p.id === id);
		const partner = row?.implementation && row.implementation !== "sim";
		return !partner || deps.getProvider(id) !== undefined;
	});
	const domestic = corridor.domesticRail && corridor.from.country === corridor.to.country;
	if ((kind === "collect" || kind === "payout") && domestic) {
		candidateIds = [corridor.domesticRail!];
	}

	// Payout: keep only providers that match the destination type (CCR-3 decision 5 lives in routing).
	if (kind === "payout") {
		candidateIds = candidateIds.filter((id) => {
			const p = deps.getProvider(id);
			if (!p) return false;
			const caps = p.capabilities();
			return (
				caps.endpointTypes.includes(destination.type) &&
				(destination.country === "" || caps.countries.includes(destination.country))
			);
		});
		if (candidateIds.length === 0) {
			return {
				ok: false,
				reasons: [`No payout provider for ${destination.type} in corridor`, ...exclusionReasons],
			};
		}
	}

	const endpointCountry = destination.country !== "" ? destination.country : corridor.to.country;
	const candidates = await healthyProviders(
		candidateIds,
		kind,
		deps.getProvider,
		exclusionReasons,
		kind === "payout" ? destination.type : undefined,
		kind === "payout" ? endpointCountry : undefined,
	);
	if (candidates.length === 0) {
		return {
			ok: false,
			reasons: [`No healthy ${kind} provider in config order`, ...exclusionReasons],
		};
	}
	const endpoint: EndpointRef | undefined =
		kind === "payout"
			? {
					endpointId: "quote_dest",
					type: destination.type,
					country: endpointCountry,
					currency: destination.currency,
					...(destination.details ? { details: destination.details } : {}),
					...(destination.recipientAddress
						? { recipientAddress: destination.recipientAddress }
						: {}),
				}
			: undefined;
	return { ok: true, candidates, endpoint };
}

type PairOption = {
	label: string;
	legs: [PricedLeg, PricedLeg];
};

/**
 * CCR-29: prices the convert + payout tail. Two kinds of option compete on what the recipient
 * receives: (a) an off-ramp partner doing both legs itself, and (b) the best plain convert
 * followed by the best plain payout (the CCR-28 per-leg choice). A tie keeps the plain route,
 * so corridors without a partner behave exactly as before.
 */
async function pricePayoutPair(
	deps: PriceDeps,
	corridor: Corridor,
	destination: Destination,
	amountIn: Money,
	convertOut: string,
	payoutOut: string,
	exclusionReasons: string[],
): Promise<
	| { ok: true; legs: [PricedLeg, PricedLeg]; others: Array<{ label: string; legs: [PricedLeg, PricedLeg] }> }
	| PriceFail
> {
	const conv = await legCandidates(deps, corridor, "convert", destination, exclusionReasons);
	if (!conv.ok) return conv;
	const pay = await legCandidates(deps, corridor, "payout", destination, exclusionReasons);
	if (!pay.ok) return pay;

	const options: PairOption[] = [];
	let firstError: string | null = null;

	const plainConv = conv.candidates.filter((a) => !isOfframp(a));
	const plainPay = pay.candidates.filter((a) => !isOfframp(a));
	if (plainConv.length > 0 && plainPay.length > 0) {
		const c = await bestQuote(
			plainConv,
			"convert",
			{ kind: "convert", amountIn, outCurrency: convertOut },
			exclusionReasons,
		);
		if (c.ok) {
			const convertLeg = pricedLeg("convert", amountIn, c.adapter, c.quoted);
			const p = await bestQuote(
				plainPay,
				"payout",
				{ kind: "payout", amountIn: convertLeg.amountOut, outCurrency: payoutOut, endpoint: pay.endpoint },
				exclusionReasons,
			);
			if (p.ok) {
				options.push({
					label: `${c.adapter.id} + ${p.adapter.id}`,
					legs: [convertLeg, pricedLeg("payout", convertLeg.amountOut, p.adapter, p.quoted)],
				});
			} else firstError ??= p.reasons[0] ?? null;
		} else firstError ??= c.reasons[0] ?? null;
	}

	const payIds = new Set(pay.candidates.map((a) => a.id));
	for (const partner of conv.candidates.filter((a) => isOfframp(a) && payIds.has(a.id))) {
		const blocked = await excludeForPayoutFields(partner, pay.endpoint, exclusionReasons);
		if (blocked) {
			firstError ??= blocked;
			continue;
		}
		try {
			// The off-ramp prices the whole pair, so it also needs the payout endpoint (country).
			const cq = await partner.quote({
				kind: "convert",
				amountIn,
				outCurrency: convertOut,
				endpoint: pay.endpoint,
			});
			const convertLeg = pricedLeg("convert", amountIn, partner, cq);
			const pq = await partner.quote({
				kind: "payout",
				amountIn: convertLeg.amountOut,
				outCurrency: payoutOut,
				endpoint: pay.endpoint,
			});
			options.push({
				label: partner.id,
				legs: [convertLeg, pricedLeg("payout", convertLeg.amountOut, partner, pq)],
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : `Provider ${partner.id} quote failed`;
			firstError ??= msg;
			exclusionReasons.push(`Provider ${partner.id} could not quote convert + payout: ${msg}`);
		}
	}

	if (options.length === 0) {
		return {
			ok: false,
			reasons: [firstError ?? "No convert + payout route could quote", ...exclusionReasons],
		};
	}
	let best = options[0]!;
	for (const o of options.slice(1)) {
		if (toMinor(o.legs[1].amountOut) > toMinor(best.legs[1].amountOut)) best = o;
	}
	if (options.length > 1) {
		const others = options
			.filter((o) => o !== best)
			.map((o) => `${o.label} ${o.legs[1].amountOut.amount} ${o.legs[1].amountOut.currency}`)
			.join(", ");
		exclusionReasons.push(
			`Best payout route: ${best.label} delivers ${best.legs[1].amountOut.amount} ${best.legs[1].amountOut.currency} (others: ${others})`,
		);
	}
	const others = options
		.filter((o) => o !== best)
		.sort((a, b) => (toMinor(b.legs[1].amountOut) > toMinor(a.legs[1].amountOut) ? 1 : -1));
	return { ok: true, legs: best.legs, others };
}

export async function priceRoute(
	deps: PriceDeps,
	corridor: Corridor,
	template: RouteTemplate,
	sendAmount: Money,
	destination: Destination,
): Promise<PriceResult> {
	const exclusionReasons: string[] = [];
	const settleAsset = settlementAsset(corridor, deps.config);
	const outs = outCurrenciesFor(
		template,
		corridor,
		destination.currency,
		settleAsset,
	);

	const legs: PricedLeg[] = [];
	let amountIn = sendAmount;
	let totalTime = 0;
	let settleUnlockedRemainder: Money | null = null;

	let pairAt = -1;
	let pairOthers: Array<{ label: string; legs: [PricedLeg, PricedLeg] }> = [];
	for (let i = 0; i < template.length; i++) {
		const kind = template[i]!;
		const outCurrency = outs[i]!;

		if (kind === "settle") {
			const railId = corridor.legsAvailable.settle[0];
			if (!railId) {
				return { ok: false, reasons: ["Corridor has no settle rail"] };
			}
			if (
				deps.vaultFeeMode !== "PayerPays" &&
				deps.vaultFeeMode !== "RecipientPays"
			) {
				return {
					ok: false,
					reasons: [
						"vaultFeeMode is required for settle legs (CCR-8); no silent default",
					],
				};
			}
			const priced = priceSettle(
				amountIn,
				railId,
				deps.vaultFeeBps,
				deps.vaultFeeMode,
				deps.settlementSimulated,
				shouldFloorSettleForSolanaMint(railId, destination.type),
			);
			if (!priced.ok) {
				return { ok: false, reasons: [priced.error] };
			}
			if (priced.remainderNote) {
				exclusionReasons.push(priced.remainderNote);
			}
			settleUnlockedRemainder = priced.unlockedRemainder;
			legs.push(priced.leg);
			amountIn = priced.leg.amountOut;
			continue;
		}

		const nextKind = template[i + 1];
		if (kind === "convert" && nextKind === "payout") {
			// CCR-29: price convert + payout together so an off-ramp partner (one that converts and
			// pays out in a single step, like BlindPay) is compared on what the recipient receives.
			const pair = await pricePayoutPair(
				deps,
				corridor,
				destination,
				amountIn,
				outCurrency,
				outs[i + 1]!,
				exclusionReasons,
			);
			if (!pair.ok) return pair;
			pairAt = legs.length;
			pairOthers = pair.others;
			for (const leg of pair.legs) {
				legs.push(leg);
				totalTime += leg.estimatedTimeSeconds;
			}
			amountIn = pair.legs[pair.legs.length - 1]!.amountOut;
			i++;
			continue;
		}

		const found = await legCandidates(deps, corridor, kind, destination, exclusionReasons);
		if (!found.ok) return found;
		// CCR-29: an off-ramp partner only serves the convert + payout pair, never a lone leg.
		const candidates = found.candidates.filter((a) => !isOfframp(a));
		if (candidates.length === 0) {
			return {
				ok: false,
				reasons: [`No healthy ${kind} provider in config order`, ...exclusionReasons],
			};
		}

		const chosen = await bestQuote(
			candidates,
			kind,
			{ kind, amountIn, outCurrency, endpoint: found.endpoint },
			exclusionReasons,
		);
		if (!chosen.ok) {
			return {
				ok: false,
				reasons: [...chosen.reasons, ...exclusionReasons],
			};
		}
		const leg = pricedLeg(kind, amountIn, chosen.adapter, chosen.quoted);
		legs.push(leg);
		totalTime += leg.estimatedTimeSeconds;
		amountIn = leg.amountOut;
	}

	const expectedReceive = amountIn;
	if (expectedReceive.currency !== destination.currency) {
		return {
			ok: false,
			reasons: [
				`Route delivered ${expectedReceive.currency} but destination is ${destination.currency}`,
			],
		};
	}

	const fromCurrency = corridor.from.currency;
	const settleLeg = legs.find((l) => l.kind === "settle");
	const flexiPayFee = settleLeg
		? settleLeg.fee
		: money(0n, fromCurrency);

	const feeLegs = legs.map((l) => ({
		kind: l.kind,
		rail: l.rail,
		fee: l.fee,
	}));

	const summed = sumFeesTotal(
		legs,
		flexiPayFee,
		fromCurrency,
		deps.config.fxRates,
	);
	if (!summed.ok) {
		return { ok: false, reasons: summed.reasons };
	}

	const fxRate = overallFxRate(sendAmount, expectedReceive);

	// Losing payout options as full routes, so clients can show what the aggregator saved.
	const alternatives: PricedAlternative[] = [];
	for (const other of pairOthers) {
		if (other.legs[1].amountOut.currency !== expectedReceive.currency) continue;
		const altLegs = [...legs.slice(0, pairAt), ...other.legs, ...legs.slice(pairAt + 2)];
		const altSummed = sumFeesTotal(altLegs, flexiPayFee, fromCurrency, deps.config.fxRates);
		if (!altSummed.ok) continue;
		alternatives.push({
			legs: altLegs,
			totalCost: altSummed.total,
			estimatedTimeSeconds: altLegs.reduce((t, l) => t + l.estimatedTimeSeconds, 0),
			reasons: [`Via ${other.label}: delivers ${other.legs[1].amountOut.amount} ${other.legs[1].amountOut.currency}`],
		});
	}

	return {
		ok: true,
		priced: {
			alternatives,
			legs,
			expectedReceive,
			fees: {
				legs: feeLegs,
				flexiPayFee,
				total: summed.total,
				settleUnlockedRemainder,
			},
			fxRate,
			estimatedTimeSeconds: totalTime,
			exclusionReasons,
		},
	};
}

/** Major-unit effective rate send → receive, or null when currencies match / receive is zero. */
function overallFxRate(send: Money, receive: Money): string | null {
	if (send.currency === receive.currency) return null;
	const s = toMinor(send);
	const r = toMinor(receive);
	if (s === 0n || r === 0n) return null;

	const fromDec = decimals(send.currency);
	const toDec = decimals(receive.currency);
	// rate_major = (r / 10^toDec) / (s / 10^fromDec) = r * 10^fromDec / (s * 10^toDec)
	// Format with up to 7 decimal places, trimming is fine as RateString allows 1–7.
	const scale = 7n;
	const num = r * 10n ** BigInt(fromDec) * 10n ** scale;
	const den = s * 10n ** BigInt(toDec);
	const scaled = num / den;
	const whole = scaled / 10n ** scale;
	const frac = (scaled % 10n ** scale).toString().padStart(7, "0");
	return `${whole}.${frac}`;
}

function decimals(currency: string): number {
	const d = CURRENCY_DECIMALS[currency];
	if (d === undefined) throw new Error(`unknown currency decimals for ${currency}`);
	return d;
}
