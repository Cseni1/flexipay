import { useEffect, useState } from "react"
import { getQuote } from "../api/client"
import {
	computeAggregatorSaving,
	type AggregatorSaving,
} from "../payments/aggregatorSaving"
import {
	linkPaymentSaving,
	lookupStoredSaving,
	rememberQuoteSaving,
} from "../payments/quoteSavingStore"

/**
 * Resolve aggregator saving for a payment: prefer GET /v1/quotes/{id} when the
 * API still retains the quote; otherwise use the session store from create time.
 * Shows nothing when neither source yields a positive saving.
 */
export function usePaymentSaving(
	payment: { id: string; quoteId: string } | null | undefined,
): AggregatorSaving | null {
	const paymentId = payment?.id
	const quoteId = payment?.quoteId
	const [saving, setSaving] = useState<AggregatorSaving | null>(() =>
		paymentId && quoteId ? lookupStoredSaving({ paymentId, quoteId }) : null,
	)

	useEffect(() => {
		if (!paymentId || !quoteId) {
			setSaving(null)
			return
		}

		const fromSession = lookupStoredSaving({ paymentId, quoteId })
		setSaving(fromSession)

		let cancelled = false
		void getQuote(quoteId)
			.then((quote) => {
				if (cancelled) return
				const computed = computeAggregatorSaving(quote)
				if (computed) {
					rememberQuoteSaving(quote.id, computed)
					linkPaymentSaving(paymentId, quote.id)
				}
				setSaving(computed)
			})
			.catch(() => {
				if (!cancelled) setSaving(fromSession)
			})

		return () => {
			cancelled = true
		}
	}, [paymentId, quoteId])

	return saving
}
