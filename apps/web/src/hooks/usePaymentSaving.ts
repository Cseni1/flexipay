import { type Quote } from "@flexipay/web-lib/contract"
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
	return usePaymentQuote(payment).saving
}

/**
 * Same lookup as usePaymentSaving, also returning the quote itself (fees, rate)
 * when the API still has it. One GET /v1/quotes/{id} per payment.
 */
export function usePaymentQuote(
	payment: { id: string; quoteId: string } | null | undefined,
): { quote: Quote | null; saving: AggregatorSaving | null } {
	const paymentId = payment?.id
	const quoteId = payment?.quoteId
	const [saving, setSaving] = useState<AggregatorSaving | null>(() =>
		paymentId && quoteId ? lookupStoredSaving({ paymentId, quoteId }) : null,
	)
	const [quote, setQuote] = useState<Quote | null>(null)

	useEffect(() => {
		if (!paymentId || !quoteId) {
			setSaving(null)
			setQuote(null)
			return
		}

		const fromSession = lookupStoredSaving({ paymentId, quoteId })
		setSaving(fromSession)

		let cancelled = false
		void getQuote(quoteId)
			.then((loaded) => {
				if (cancelled) return
				setQuote(loaded)
				const computed = computeAggregatorSaving(loaded)
				if (computed) {
					rememberQuoteSaving(loaded.id, computed)
					linkPaymentSaving(paymentId, loaded.id)
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

	return { quote, saving }
}
