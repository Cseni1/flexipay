import type { FeeMode } from "../enums.ts";
import { compareMoney, money, toMinor, type Money } from "../money.ts";
import type { FlexiPayConfig } from "../config/schemas.ts";
import type { ProviderAdapter } from "../adapters.ts";
import type { CreateQuoteRequest, Quote } from "../api/quotes.ts";
import { QuoteSchema } from "../api/quotes.ts";
import {
	checkEligibility,
	type EligibilityFail,
} from "./eligibility.ts";
import {
	priceRoute,
	toPlannedLegs,
	type PriceDeps,
	type PricedRoute,
} from "./price.ts";

// Build a Quote from a CreateQuoteRequest (ARCHITECTURE §8). Pure over config + injected adapters.

export interface BuildQuoteDeps {
	config: FlexiPayConfig;
	getProvider: (id: string) => ProviderAdapter | undefined;
	/**
	 * Vault fixed fee in basis points from `SettlementAdapter.feeBps()`.
	 * Required when the chosen template includes settle; ignored otherwise.
	 */
	vaultFeeBps: number;
	/**
	 * Optional mirror of CreateQuoteRequest.feeMode for adapter wiring checks.
	 * CCR-8 source of truth for settle routes is always `req.feeMode`.
	 */
	vaultFeeMode?: FeeMode;
	/**
	 * Settle-leg simulated label from settlement execution mode (CCR-10).
	 * Required when the template includes settle. Not inferred from `stellar_usdc` alone.
	 */
	settlementSimulated: boolean;
	/** API clock; defaults to `() => new Date()`. */
	now?: () => Date;
	/** Quote id factory; defaults to a `quo_` + random hex id. */
	quoteId?: () => string;
}

export type BuildQuoteResult =
	| { ok: true; quote: Quote }
	| { ok: false; reasons: string[] };

function defaultQuoteId(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return `quo_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function priceDeps(deps: BuildQuoteDeps, feeMode: FeeMode | null): PriceDeps {
	return {
		config: deps.config,
		getProvider: deps.getProvider,
		vaultFeeBps: deps.vaultFeeBps,
		vaultFeeMode: feeMode,
		settlementSimulated: deps.settlementSimulated,
	};
}

/**
 * CCR-8: settle routes take feeMode only from CreateQuoteRequest.feeMode (no silent default).
 * If deps.vaultFeeMode is also set, it must match the request.
 */
function resolveSettleFeeMode(
	req: CreateQuoteRequest,
	deps: BuildQuoteDeps,
): { ok: true; feeMode: FeeMode } | { ok: false; reasons: string[] } {
	const fromRequest = req.feeMode;
	if (fromRequest !== "PayerPays" && fromRequest !== "RecipientPays") {
		return {
			ok: false,
			reasons: [
				"CreateQuoteRequest.feeMode (PayerPays | RecipientPays) is required for settle routes (CCR-8); no silent MVP default",
			],
		};
	}
	if (
		deps.vaultFeeMode !== undefined &&
		deps.vaultFeeMode !== fromRequest
	) {
		return {
			ok: false,
			reasons: [
				`feeMode mismatch: CreateQuoteRequest.feeMode=${fromRequest} but vaultFeeMode=${deps.vaultFeeMode}`,
			],
		};
	}
	return { ok: true, feeMode: fromRequest };
}

function assembleQuote(
	req: CreateQuoteRequest,
	deps: BuildQuoteDeps,
	eligibilityReasons: string[],
	priced: PricedRoute,
	feeMode: FeeMode | null,
): Quote {
	const now = (deps.now ?? (() => new Date()))();
	const validUntil = new Date(
		now.getTime() + deps.config.fees.quoteValiditySeconds * 1000,
	).toISOString();

	const reasons = [
		...eligibilityReasons,
		...priced.exclusionReasons.filter(
			(r) => !eligibilityReasons.includes(r),
		),
	];

	const hasSettle = priced.legs.some((l) => l.kind === "settle");
	const quote: Quote = {
		id: (deps.quoteId ?? defaultQuoteId)(),
		source: req.source,
		destination: req.destination,
		amount: req.amount,
		route: toPlannedLegs(priced.legs),
		fees: priced.fees,
		fxRate: priced.fxRate,
		expectedReceive: priced.expectedReceive,
		priceRiskBearer: deps.config.fees.priceRiskBearer,
		policy: "cheapest",
		feeMode: hasSettle ? feeMode : null,
		validUntil,
		alternatives: [],
		reasons,
		simulated: true,
	};

	return QuoteSchema.parse(quote);
}

/**
 * Solve a receive-side quote by binary-searching the send amount within corridor limits.
 * Uses the same pricing chain as send-side quotes.
 */
async function priceForReceive(
	deps: BuildQuoteDeps,
	req: CreateQuoteRequest,
	eligibility: Extract<
		ReturnType<typeof checkEligibility>,
		{ ok: true }
	>,
	feeMode: FeeMode | null,
): Promise<
	| { ok: true; priced: PricedRoute; sendAmount: Money }
	| { ok: false; reasons: string[] }
> {
	const { corridor, template } = eligibility;
	const limits = corridor.limits[req.destination.recipientKind];
	const target = req.amount.value;

	let lo = toMinor(limits.min);
	let hi = toMinor(limits.max);
	let best: { send: Money; priced: PricedRoute; diff: bigint } | null = null;

	const destination = {
		type: req.destination.type,
		currency: req.destination.currency,
		country: req.destination.country,
	};

	for (let iter = 0; iter < 64 && lo <= hi; iter++) {
		const mid = (lo + hi) / 2n;
		const sendAmount = money(mid, corridor.from.currency);
		const priced = await priceRoute(
			priceDeps(deps, feeMode),
			corridor,
			template,
			sendAmount,
			destination,
		);
		if (!priced.ok) {
			lo = mid + 1n;
			continue;
		}
		const got = toMinor(priced.priced.expectedReceive);
		const want = toMinor(target);
		const diff = got > want ? got - want : want - got;
		if (!best || diff < best.diff) {
			best = { send: sendAmount, priced: priced.priced, diff };
		}
		if (got === want) {
			return { ok: true, priced: priced.priced, sendAmount };
		}
		if (got < want) lo = mid + 1n;
		else hi = mid - 1n;
	}

	if (!best) {
		return {
			ok: false,
			reasons: [
				"Could not find a send amount that satisfies the receive target within corridor limits",
			],
		};
	}

	if (
		compareMoney(best.priced.expectedReceive, target) < 0 &&
		toMinor(best.send) < toMinor(limits.max)
	) {
		for (
			let a = toMinor(best.send) + 1n;
			a <= toMinor(limits.max);
			a++
		) {
			const sendAmount = money(a, corridor.from.currency);
			const priced = await priceRoute(
				priceDeps(deps, feeMode),
				corridor,
				template,
				sendAmount,
				destination,
			);
			if (!priced.ok) continue;
			if (compareMoney(priced.priced.expectedReceive, target) >= 0) {
				return { ok: true, priced: priced.priced, sendAmount };
			}
		}
	}

	return { ok: true, priced: best.priced, sendAmount: best.send };
}

export async function buildQuote(
	req: CreateQuoteRequest,
	deps: BuildQuoteDeps,
): Promise<BuildQuoteResult> {
	const eligibility = checkEligibility(req, deps.config);
	if (!eligibility.ok) {
		return eligibility satisfies EligibilityFail;
	}

	let feeMode: FeeMode | null = null;
	if (eligibility.template.includes("settle")) {
		if (!Number.isInteger(deps.vaultFeeBps) || deps.vaultFeeBps < 0) {
			return {
				ok: false,
				reasons: [
					"vaultFeeBps from SettlementAdapter.feeBps() is required for settle routes",
				],
			};
		}
		const resolved = resolveSettleFeeMode(req, deps);
		if (!resolved.ok) return resolved;
		feeMode = resolved.feeMode;
		if (typeof deps.settlementSimulated !== "boolean") {
			return {
				ok: false,
				reasons: [
					"settlementSimulated (boolean from FP_SETTLEMENT execution mode) is required for settle routes (CCR-10); do not infer from rail id alone",
				],
			};
		}
	}

	const destination = {
		type: req.destination.type,
		currency: req.destination.currency,
		country: req.destination.country,
	};

	if (req.amount.side === "send") {
		const priced = await priceRoute(
			priceDeps(deps, feeMode),
			eligibility.corridor,
			eligibility.template,
			req.amount.value,
			destination,
		);
		if (!priced.ok) return priced;
		return {
			ok: true,
			quote: assembleQuote(
				req,
				deps,
				eligibility.reasons,
				priced.priced,
				feeMode,
			),
		};
	}

	const solved = await priceForReceive(deps, req, eligibility, feeMode);
	if (!solved.ok) return solved;

	const limits =
		eligibility.corridor.limits[req.destination.recipientKind];
	if (compareMoney(solved.sendAmount, limits.min) < 0) {
		return {
			ok: false,
			reasons: [
				`Resolved send amount ${solved.sendAmount.amount} is below the minimum ${limits.min.amount} ${limits.min.currency}`,
			],
		};
	}
	if (compareMoney(solved.sendAmount, limits.max) > 0) {
		return {
			ok: false,
			reasons: [
				`Resolved send amount ${solved.sendAmount.amount} is above the maximum ${limits.max.amount} ${limits.max.currency}`,
			],
		};
	}

	return {
		ok: true,
		quote: assembleQuote(
			req,
			deps,
			eligibility.reasons,
			solved.priced,
			feeMode,
		),
	};
}
