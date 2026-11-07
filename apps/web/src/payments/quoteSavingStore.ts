import {
	computeAggregatorSaving,
	type AggregatorSaving,
} from "./aggregatorSaving"

const STORAGE_KEY = "flexipay.aggregatorSavings.v1"

type StoreShape = {
	byQuoteId: Record<string, AggregatorSaving>
	paymentToQuote: Record<string, string>
}

const emptyStore = (): StoreShape => ({
	byQuoteId: {},
	paymentToQuote: {},
})

const storage = (): Storage | null =>
	typeof sessionStorage === "undefined" ? null : sessionStorage

const readStore = (): StoreShape => {
	const raw = storage()?.getItem(STORAGE_KEY)
	if (!raw) return emptyStore()
	try {
		const parsed = JSON.parse(raw) as Partial<StoreShape>
		return {
			byQuoteId:
				parsed.byQuoteId && typeof parsed.byQuoteId === "object"
					? parsed.byQuoteId
					: {},
			paymentToQuote:
				parsed.paymentToQuote && typeof parsed.paymentToQuote === "object"
					? parsed.paymentToQuote
					: {},
		}
	} catch {
		return emptyStore()
	}
}

const writeStore = (store: StoreShape): void => {
	try {
		storage()?.setItem(STORAGE_KEY, JSON.stringify(store))
	} catch {
		// Quota / private mode: Demo Day savings are best-effort for the session.
	}
}

/** Persist the saving computed from a quote for later payment/detail/dashboard use. */
export function rememberQuoteSaving(
	quoteId: string,
	saving: AggregatorSaving | null,
): void {
	if (!saving) return
	const store = readStore()
	store.byQuoteId[quoteId] = {
		amount: saving.amount,
		currency: saving.currency,
		nextBestLabel: saving.nextBestLabel,
	}
	writeStore(store)
}

/** Remember savings from a full quote object (create-quote / GET quote). */
export function rememberSavingFromQuote(
	quote: Parameters<typeof computeAggregatorSaving>[0] & { id: string },
): AggregatorSaving | null {
	const saving = computeAggregatorSaving(quote)
	rememberQuoteSaving(quote.id, saving)
	return saving
}

/** Link a created payment to its quote so list/detail can resolve the saving. */
export function linkPaymentSaving(paymentId: string, quoteId: string): void {
	const store = readStore()
	store.paymentToQuote[paymentId] = quoteId
	writeStore(store)
}

export function lookupStoredSaving(keys: {
	paymentId?: string
	quoteId?: string
}): AggregatorSaving | null {
	const store = readStore()
	const quoteId =
		keys.quoteId ??
		(keys.paymentId ? store.paymentToQuote[keys.paymentId] : undefined)
	if (!quoteId) return null
	const saving = store.byQuoteId[quoteId]
	return saving ?? null
}
