import type { EndpointType, FeeMode, LegKind } from "../enums.ts";
import {
	CURRENCY_DECIMALS,
	addMoney,
	applyBps,
	convertMoney,
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
} from "../adapters.ts";
import type { FeeBreakdown, PlannedLeg } from "../api/common.ts";
import type { RouteTemplate } from "./templates.ts";

// Leg pricing through ProviderAdapter.quote and vault feeBps (ARCHITECTURE §8 step 4, CCR-4).

export interface PricedLeg {
	kind: LegKind;
	rail: string;
	providerId: string;
	simulated: true;
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
}

function settlementAsset(corridor: Corridor, config: FlexiPayConfig): string | undefined {
	const railId = corridor.legsAvailable.settle[0];
	if (!railId) return undefined;
	return config.settlementRails.find((r) => r.id === railId)?.asset;
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
		simulated: true,
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

async function firstHealthyProvider(
	ids: readonly string[],
	kind: LegKind,
	getProvider: (id: string) => ProviderAdapter | undefined,
	exclusionReasons: string[],
	/** When set, the provider must serve this endpoint type (payout / collect). */
	endpointType?: EndpointType,
	endpointCountry?: string,
): Promise<ProviderAdapter | null> {
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
		return adapter;
	}
	return null;
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
):
	| { ok: true; leg: PricedLeg; remainderNote?: string }
	| { ok: false; error: string } {
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
		return {
			ok: true,
			leg: {
				kind: "settle",
				rail: railId,
				providerId: railId,
				simulated: true,
				fee,
				fxRate: null,
				amountIn: available,
				amountOut: subtractMoney(available, fee),
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
	const remainderNote =
		toMinor(sized.remainder) > 0n
			? `PayerPays settle remainder ${sized.remainder.amount} ${sized.remainder.currency} stays unlocked (not a fee; CCR-8)`
			: undefined;
	return {
		ok: true,
		leg: {
			kind: "settle",
			rail: railId,
			providerId: railId,
			simulated: true,
			fee: sized.fee,
			fxRate: null,
			amountIn: sized.principal,
			amountOut: sized.principal,
			estimatedTimeSeconds: 0,
		},
		remainderNote,
	};
}

export async function priceRoute(
	deps: PriceDeps,
	corridor: Corridor,
	template: RouteTemplate,
	sendAmount: Money,
	destination: {
		type: EndpointType;
		currency: string;
		country: string;
	},
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
			);
			if (!priced.ok) {
				return { ok: false, reasons: [priced.error] };
			}
			if (priced.remainderNote) {
				exclusionReasons.push(priced.remainderNote);
			}
			legs.push(priced.leg);
			amountIn = priced.leg.amountOut;
			continue;
		}

		let candidateIds = [...corridor.legsAvailable[kind]];
		if (
			kind === "collect" &&
			corridor.domesticRail &&
			corridor.from.country === corridor.to.country
		) {
			candidateIds = [corridor.domesticRail];
		}
		if (
			kind === "payout" &&
			corridor.domesticRail &&
			corridor.from.country === corridor.to.country
		) {
			candidateIds = [corridor.domesticRail];
		}

		// Payout: keep only providers that match the destination type (CCR-3 decision 5 lives in routing).
		if (kind === "payout") {
			candidateIds = candidateIds.filter((id) => {
				const p = deps.getProvider(id);
				if (!p) return false;
				const caps = p.capabilities();
				return (
					caps.endpointTypes.includes(destination.type) &&
					(destination.country === "" ||
						caps.countries.includes(destination.country))
				);
			});
			if (candidateIds.length === 0) {
				return {
					ok: false,
					reasons: [
						`No payout provider for ${destination.type} in corridor`,
						...exclusionReasons,
					],
				};
			}
		}

		const endpointCountry =
			destination.country !== ""
				? destination.country
				: corridor.to.country;

		const adapter = await firstHealthyProvider(
			candidateIds,
			kind,
			deps.getProvider,
			exclusionReasons,
			kind === "payout" || kind === "collect"
				? kind === "payout"
					? destination.type
					: undefined
				: undefined,
			kind === "payout" ? endpointCountry : undefined,
		);

		if (!adapter) {
			return {
				ok: false,
				reasons: [
					`No healthy ${kind} provider in config order`,
					...exclusionReasons,
				],
			};
		}

		const endpoint: EndpointRef | undefined =
			kind === "payout"
				? {
						endpointId: "quote_dest",
						type: destination.type,
						country: endpointCountry,
						currency: destination.currency,
					}
				: undefined;

		let quoted: LegQuote;
		try {
			quoted = await adapter.quote({
				kind,
				amountIn,
				outCurrency,
				endpoint,
			});
		} catch (e) {
			const msg =
				e instanceof Error ? e.message : `Provider ${adapter.id} quote failed`;
			return {
				ok: false,
				reasons: [msg, ...exclusionReasons],
			};
		}

		const simulated = quoted.simulated === true;
		if (!simulated) {
			// Quote schema requires simulated: true on planned legs in the MVP.
			exclusionReasons.push(
				`Provider ${adapter.id} returned a non-simulated quote; MVP quotes are simulated`,
			);
		}

		legs.push({
			kind,
			rail: adapter.id,
			providerId: adapter.id,
			simulated: true,
			fee: quoted.fee,
			fxRate: quoted.fxRate,
			amountIn,
			amountOut: quoted.amountOut,
			estimatedTimeSeconds: quoted.estimatedTimeSeconds,
		});
		totalTime += quoted.estimatedTimeSeconds;
		amountIn = quoted.amountOut;
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

	return {
		ok: true,
		priced: {
			legs,
			expectedReceive,
			fees: {
				legs: feeLegs,
				flexiPayFee,
				total: summed.total,
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
