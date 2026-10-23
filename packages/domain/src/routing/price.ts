import type { EndpointType, LegKind } from "../enums.ts";
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

/** Convert fee money into `toCurrency` when a configured directional rate exists; otherwise null. */
function feeInCurrency(
	fee: Money,
	toCurrency: string,
	rates: FxRate[],
): Money | null {
	if (fee.currency === toCurrency) return fee;
	const rate = rateLookup(rates, fee.currency, toCurrency);
	if (!rate) return null;
	return convertMoney(fee, rate.rate, toCurrency);
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

function priceSettle(
	amountIn: Money,
	railId: string,
	vaultFeeBps: number,
): PricedLeg | { error: string } {
	let fee: Money;
	try {
		fee = applyBps(amountIn, vaultFeeBps);
	} catch (e) {
		return {
			error: e instanceof Error ? e.message : "invalid vault fee bps",
		};
	}
	if (toMinor(fee) >= toMinor(amountIn)) {
		return {
			error: `Vault fee ${fee.amount} ${fee.currency} exceeds or equals settle amount`,
		};
	}
	return {
		kind: "settle",
		rail: railId,
		providerId: railId,
		simulated: true,
		fee,
		fxRate: null,
		amountIn,
		amountOut: subtractMoney(amountIn, fee),
		estimatedTimeSeconds: 0,
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
			const priced = priceSettle(amountIn, railId, deps.vaultFeeBps);
			if ("error" in priced) {
				return { ok: false, reasons: [priced.error] };
			}
			legs.push(priced);
			amountIn = priced.amountOut;
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

	// total in send currency: provider fees already in fromCurrency + vault fee when convertible.
	// Settle fee is represented as flexiPayFee (not double-counted from the settle leg row).
	let total = money(0n, fromCurrency);
	for (const leg of legs) {
		if (leg.kind === "settle") continue;
		const converted = feeInCurrency(leg.fee, fromCurrency, deps.config.fxRates);
		if (converted) total = addMoney(total, converted);
	}
	const vaultInSend = feeInCurrency(
		flexiPayFee,
		fromCurrency,
		deps.config.fxRates,
	);
	if (vaultInSend) total = addMoney(total, vaultInSend);
	else if (flexiPayFee.currency === fromCurrency) {
		total = addMoney(total, flexiPayFee);
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
				total,
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
