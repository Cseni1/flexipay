import { isCryptoEndpoint, type EndpointType, type LegKind } from "../enums.ts";
import type { Corridor } from "../config/schemas.ts";

// Route templates (ARCHITECTURE §8, CCR-5). Chosen from corridor shape + destination type.

export type RouteTemplate = readonly LegKind[];

/**
 * Returns the ordered leg kinds for this corridor and destination, or null when the
 * corridor cannot serve that destination type (caller adds an exclusion reason).
 */
export function routeTemplate(
	corridor: Corridor,
	destinationType: EndpointType,
): RouteTemplate | null {
	const domestic = corridor.from.country === corridor.to.country;
	const hasSettle = corridor.legsAvailable.settle.length > 0;

	if (domestic) {
		// US→US: collect → payout on the domestic rail; no crypto route.
		if (isCryptoEndpoint(destinationType)) return null;
		return ["collect", "payout"];
	}

	if (isCryptoEndpoint(destinationType)) {
		// Crypto wallet: collect → convert → settle (vault releases; no payout).
		if (!hasSettle) return null;
		return ["collect", "convert", "settle"];
	}

	if (!hasSettle) {
		// South Africa style: collect → convert → payout, bank only.
		return ["collect", "convert", "payout"];
	}

	// Cross-border fiat via Stellar: collect → convert → settle → convert → payout.
	return ["collect", "convert", "settle", "convert", "payout"];
}
