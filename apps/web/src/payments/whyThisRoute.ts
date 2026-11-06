import {
	type AlternativeRoute,
	type PlannedLeg,
	type Quote,
} from "@flexipay/web-lib/contract"
import { displayMoney } from "./quoteDisplay"

const KIND_LABELS = {
	collect: "Collect",
	convert: "Convert",
	settle: "Settle",
	payout: "Payout",
} as const

export type ProviderBadge = "Simulated" | "Sandbox" | "Live"

/**
 * Today every partner path is Simulated or Sandbox — never present as Live.
 * A partner on its sandbox (CCR-29, e.g. blindpay_sandbox) reports simulated: true because no
 * real money moves, but it is a real partner API, so it is labelled Sandbox, not Simulated.
 */
export function providerBadge(
	simulated: boolean,
	providerId = "",
): ProviderBadge {
	if (providerId.endsWith("_sandbox")) return "Sandbox"
	return simulated ? "Simulated" : "Sandbox"
}

/** Short provider label from a rail / provider id. */
export function providerLabel(providerId: string): string {
	const cleaned = providerId.replace(/^sim_/, "").replace(/_/g, " ").trim()
	if (!cleaned) return providerId
	return cleaned.replace(/\b\w/g, (ch) => ch.toUpperCase())
}

export type WhyRouteLine = {
	kind: PlannedLeg["kind"]
	kindLabel: string
	chosenProvider: string
	chosenBadge: ProviderBadge
	chosenAmount: string
	sentence: string
	others: { provider: string; amount: string; badge: ProviderBadge }[]
}

const legForKind = (
	route: readonly PlannedLeg[],
	kind: PlannedLeg["kind"],
): PlannedLeg | undefined => route.find((leg) => leg.kind === kind)

/**
 * Per-leg "why this route" lines: chosen provider + alternative providers that
 * the quote API already returned for the same leg kind.
 */
export function buildWhyThisRoute(quote: Quote): WhyRouteLine[] {
	const lines: WhyRouteLine[] = []
	for (const leg of quote.route) {
		const others: WhyRouteLine["others"] = []
		const seen = new Set<string>([leg.providerId])
		for (const alternative of quote.alternatives as AlternativeRoute[]) {
			const alt = legForKind(alternative.route, leg.kind)
			if (!alt || seen.has(alt.providerId)) continue
			seen.add(alt.providerId)
			others.push({
				provider: providerLabel(alt.providerId),
				amount: displayMoney(alt.amountOut.amount, alt.amountOut.currency),
				badge: providerBadge(alt.simulated, alt.providerId),
			})
		}
		const chosenProvider = providerLabel(leg.providerId)
		const chosenAmount = displayMoney(
			leg.amountOut.amount,
			leg.amountOut.currency,
		)
		const kindLabel = KIND_LABELS[leg.kind]
		const othersText =
			others.length === 0
				? ""
				: ` (others: ${others
						.map((row) => `${row.provider} ${row.amount}`)
						.join(", ")})`
		lines.push({
			kind: leg.kind,
			kindLabel,
			chosenProvider,
			chosenBadge: providerBadge(leg.simulated, leg.providerId),
			chosenAmount,
			sentence: `${kindLabel}: ${chosenProvider} delivers ${chosenAmount}${othersText}`,
			others,
		})
	}
	return lines
}
