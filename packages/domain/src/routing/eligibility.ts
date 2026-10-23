import { isCryptoEndpoint } from "../enums.ts";
import { compareMoney } from "../money.ts";
import type { Corridor, FlexiPayConfig } from "../config/schemas.ts";
import { corridorId } from "../config/load.ts";
import type { CreateQuoteRequest } from "../api/quotes.ts";
import { routeTemplate, type RouteTemplate } from "./templates.ts";

// Hard constraints before pricing (ARCHITECTURE §8 step 2).

export interface EligibilityOk {
	ok: true;
	corridor: Corridor;
	template: RouteTemplate;
	reasons: string[];
}

export interface EligibilityFail {
	ok: false;
	reasons: string[];
}

export type EligibilityResult = EligibilityOk | EligibilityFail;

function findCorridor(
	config: FlexiPayConfig,
	fromCountry: string,
	toCountry: string,
): Corridor | undefined {
	return config.corridors.find(
		(c) => c.from.country === fromCountry && c.to.country === toCountry,
	);
}

/**
 * Corridor key in config is (`from.country`, `to.country`) — see CorridorSchema / corridors.json.
 * A0 `QuoteDestination.country` is `CountryOrEmpty`: empty is allowed for crypto endpoints (§6.3).
 *
 * Disambiguation (no arbitrary first-match):
 * - Non-empty destination.country → unique corridor from+to, or fail.
 * - Empty country + crypto → all corridors from the source that allow this type/kind with a
 *   settle rail. Exactly one → use it; zero → fail; two or more → fail (need destination.country).
 */
function resolveCorridor(
	req: CreateQuoteRequest,
	config: FlexiPayConfig,
): { corridor: Corridor } | { reasons: string[] } {
	const from = req.source.country;

	if (req.destination.country !== "") {
		const corridor = findCorridor(config, from, req.destination.country);
		if (!corridor) {
			return {
				reasons: [
					`No corridor from ${from} to ${req.destination.country}`,
				],
			};
		}
		return { corridor };
	}

	if (!isCryptoEndpoint(req.destination.type)) {
		return {
			reasons: [
				"Destination country is required for non-crypto destinations",
			],
		};
	}

	const matches = config.corridors.filter(
		(c) =>
			c.from.country === from &&
			c.allowedDestinationTypes.includes(req.destination.type) &&
			c.cryptoLegAllowed[req.destination.recipientKind] &&
			c.legsAvailable.settle.length > 0,
	);
	if (matches.length === 0) {
		return {
			reasons: [
				`No corridor from ${from} allows ${req.destination.type} for ${req.destination.recipientKind}`,
			],
		};
	}
	if (matches.length > 1) {
		const ids = matches.map((c) => corridorId(c)).join(", ");
		return {
			reasons: [
				`Ambiguous crypto corridor from ${from}: ${ids}. Set destination.country to the corridor to-country (A0 CountryOrEmpty); empty country is only valid when exactly one corridor matches.`,
			],
		};
	}
	return { corridor: matches[0]! };
}

/** Exclusion / explanation strings that belong on every successful quote for this corridor. */
export function corridorExplanationReasons(
	corridor: Corridor,
	req: CreateQuoteRequest,
): string[] {
	const reasons: string[] = [];
	const id = corridorId(corridor);

	if (corridor.from.country === corridor.to.country && corridor.domesticRail) {
		reasons.push(
			`Selected domestic rail ${corridor.domesticRail} for ${id}`,
		);
	}

	if (isCryptoEndpoint(req.destination.type)) {
		reasons.push(
			"Route ends at settle; no payout leg for crypto_wallet destinations",
		);
	}

	if (!corridor.cryptoLegAllowed[req.destination.recipientKind]) {
		reasons.push(
			`Crypto leg not allowed for ${req.destination.recipientKind} in this corridor`,
		);
	}

	return reasons;
}

export function checkEligibility(
	req: CreateQuoteRequest,
	config: FlexiPayConfig,
): EligibilityResult {
	if (req.policy !== "cheapest") {
		return {
			ok: false,
			reasons: ["Only the cheapest routing policy is supported in the MVP"],
		};
	}

	const resolved = resolveCorridor(req, config);
	if ("reasons" in resolved) return { ok: false, reasons: resolved.reasons };
	const { corridor } = resolved;

	if (req.source.currency !== corridor.from.currency) {
		return {
			ok: false,
			reasons: [
				`Source currency ${req.source.currency} does not match corridor ${corridorId(corridor)} (${corridor.from.currency})`,
			],
		};
	}

	if (!corridor.allowedDestinationTypes.includes(req.destination.type)) {
		const reasons = [
			`Destination type ${req.destination.type} is not allowed in corridor ${corridorId(corridor)}`,
		];
		if (
			isCryptoEndpoint(req.destination.type) &&
			!corridor.cryptoLegAllowed[req.destination.recipientKind]
		) {
			reasons.push(
				`Crypto leg not allowed for ${req.destination.recipientKind} in this corridor`,
			);
		}
		return { ok: false, reasons };
	}

	if (!corridor.recipientKinds.includes(req.destination.recipientKind)) {
		return {
			ok: false,
			reasons: [
				`Recipient kind ${req.destination.recipientKind} is not allowed in corridor ${corridorId(corridor)}`,
			],
		};
	}

	if (
		isCryptoEndpoint(req.destination.type) &&
		!corridor.cryptoLegAllowed[req.destination.recipientKind]
	) {
		return {
			ok: false,
			reasons: [
				`Crypto leg not allowed for ${req.destination.recipientKind} in this corridor`,
			],
		};
	}

	const template = routeTemplate(corridor, req.destination.type);
	if (!template) {
		return {
			ok: false,
			reasons: [
				`No route template for ${req.destination.type} in corridor ${corridorId(corridor)}`,
			],
		};
	}

	if (req.amount.side === "send") {
		const sendAmount = req.amount.value;
		if (sendAmount.currency !== corridor.from.currency) {
			return {
				ok: false,
				reasons: [
					`Send amount currency ${sendAmount.currency} must be ${corridor.from.currency}`,
				],
			};
		}
		const limits = corridor.limits[req.destination.recipientKind];
		if (compareMoney(sendAmount, limits.min) < 0) {
			return {
				ok: false,
				reasons: [
					`Send amount ${sendAmount.amount} is below the minimum ${limits.min.amount} ${limits.min.currency}`,
				],
			};
		}
		if (compareMoney(sendAmount, limits.max) > 0) {
			return {
				ok: false,
				reasons: [
					`Send amount ${sendAmount.amount} is above the maximum ${limits.max.amount} ${limits.max.currency}`,
				],
			};
		}
	} else if (req.amount.value.currency !== req.destination.currency) {
		return {
			ok: false,
			reasons: [
				`Receive amount currency ${req.amount.value.currency} must be ${req.destination.currency}`,
			],
		};
	}

	return {
		ok: true,
		corridor,
		template,
		reasons: corridorExplanationReasons(corridor, req),
	};
}
