import { type AlternativeRoute, type Quote } from "@flexipay/web-lib/contract"
import { providerLabel } from "./providerNames"
import { displayMoney } from "./quoteDisplay"

/** Positive receive advantage of the chosen quote over the next-best alternative. */
export type AggregatorSaving = {
	amount: string
	currency: string
	nextBestLabel: string
}

const alternativeReceive = (
	alternative: AlternativeRoute,
	currency: string,
): { amount: bigint; label: string } | null => {
	const last = alternative.route.at(-1)
	if (!last || last.amountOut.currency !== currency) return null
	if (!/^\d+$/.test(last.amountOut.amount)) return null
	const payout = [...alternative.route]
		.reverse()
		.find((leg) => leg.kind === "payout")
	const labelSource = payout ?? last
	return {
		amount: BigInt(last.amountOut.amount),
		label: providerLabel(labelSource.providerId || labelSource.rail),
	}
}

/**
 * Diff of chosen `expectedReceive` vs the highest same-currency receive among
 * "Other eligible routes". Hidden when there is no alternative or the diff ≤ 0.
 */
export function computeAggregatorSaving(
	quote: Pick<Quote, "expectedReceive" | "alternatives">,
): AggregatorSaving | null {
	const chosen = quote.expectedReceive
	if (!/^\d+$/.test(chosen.amount)) return null

	let nextBest: { amount: bigint; label: string } | null = null
	for (const alternative of quote.alternatives) {
		const candidate = alternativeReceive(alternative, chosen.currency)
		if (!candidate) continue
		if (!nextBest || candidate.amount > nextBest.amount) {
			nextBest = candidate
		}
	}
	if (!nextBest) return null

	const diff = BigInt(chosen.amount) - nextBest.amount
	if (diff <= 0n) return null

	return {
		amount: diff.toString(),
		currency: chosen.currency,
		nextBestLabel: nextBest.label,
	}
}

export const formatQuoteSavingLine = (saving: AggregatorSaving): string =>
	`You get ${displayMoney(saving.amount, saving.currency)} more than the next best route (${saving.nextBestLabel})`

export const formatPaymentSavingLine = (saving: AggregatorSaving): string =>
	`Saved ${displayMoney(saving.amount, saving.currency)} vs next best`

/** Sum session/per-payment savings by currency for the dashboard card. */
export function sumSavingsByCurrency(
	savings: readonly AggregatorSaving[],
): AggregatorSaving[] {
	const totals = new Map<string, bigint>()
	for (const saving of savings) {
		if (!/^\d+$/.test(saving.amount)) continue
		totals.set(
			saving.currency,
			(totals.get(saving.currency) ?? 0n) + BigInt(saving.amount),
		)
	}
	return [...totals.entries()].map(([currency, amount]) => ({
		amount: amount.toString(),
		currency,
		nextBestLabel: "",
	}))
}
