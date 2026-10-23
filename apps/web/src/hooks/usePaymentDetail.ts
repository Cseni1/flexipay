import { type PaymentDetail } from "@flexipay/web-lib/contract"
import { useCallback, useEffect, useState } from "react"
import { ApiError, getPayment } from "../api/client"

const POLLING_STATUSES = new Set(["funded", "processing", "refunding"])
const POLL_INTERVAL_MS = 2000

interface PaymentDetailState {
	payment: PaymentDetail | null
	error: ApiError | null
	loading: boolean
	refresh: () => void
}

/** Loads a payment and polls only while it is moving; the cleanup stops it on navigation. */
export function usePaymentDetail(
	paymentId: string | undefined,
): PaymentDetailState {
	const [payment, setPayment] = useState<PaymentDetail | null>(null)
	const [error, setError] = useState<ApiError | null>(null)
	const [loading, setLoading] = useState(true)
	const [refreshToken, setRefreshToken] = useState(0)

	const refresh = useCallback(() => setRefreshToken((token) => token + 1), [])

	useEffect(() => {
		if (!paymentId) {
			setLoading(false)
			setError(
				new ApiError(0, "missing_payment_id", "No payment id in the URL."),
			)
			return
		}

		let stopped = false
		let timer: number | undefined
		const controller = new AbortController()

		const load = async () => {
			try {
				const next = await getPayment(paymentId, controller.signal)
				if (stopped) return
				setPayment(next)
				setError(null)
				setLoading(false)
				if (POLLING_STATUSES.has(next.status)) {
					timer = window.setTimeout(load, POLL_INTERVAL_MS)
				}
			} catch (cause) {
				if (stopped || controller.signal.aborted) return
				setLoading(false)
				setError(
					cause instanceof ApiError
						? cause
						: new ApiError(
								0,
								"unknown_error",
								"The payment could not be loaded.",
							),
				)
			}
		}

		void load()
		return () => {
			stopped = true
			controller.abort()
			if (timer !== undefined) window.clearTimeout(timer)
		}
	}, [paymentId, refreshToken])

	return { payment, error, loading, refresh }
}
