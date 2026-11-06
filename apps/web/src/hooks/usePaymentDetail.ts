import { type PaymentDetail } from "@flexipay/web-lib/contract"
import { useCallback, useEffect, useState } from "react"
import { ApiError, getPayment } from "../api/client"
import { isWaitingOnLeg, shouldPollPayment } from "../payments/pollRules"

/** While the payment is moving between legs (sim legs finish in seconds). */
const FAST_POLL_MS = 2000
/** While a leg is with a partner (processing, seconds to days). */
const POLL_INTERVAL_MS = 10_000
/** Never leave the detail screen polling forever. */
const POLL_BUDGET_MS = 15 * 60_000

interface PaymentDetailState {
	payment: PaymentDetail | null
	error: ApiError | null
	loading: boolean
	/** True while auto-refresh is active for a processing leg. */
	polling: boolean
	refresh: () => void
}

/**
 * Loads a payment and, while status is processing and a leg is still processing,
 * re-fetches every 10s for up to 15 minutes. Cleanup stops the timer on leave.
 */
export function usePaymentDetail(
	paymentId: string | undefined,
): PaymentDetailState {
	const [payment, setPayment] = useState<PaymentDetail | null>(null)
	const [error, setError] = useState<ApiError | null>(null)
	const [loading, setLoading] = useState(true)
	const [polling, setPolling] = useState(false)
	const [refreshToken, setRefreshToken] = useState(0)

	const refresh = useCallback(() => setRefreshToken((token) => token + 1), [])

	useEffect(() => {
		if (!paymentId) {
			setLoading(false)
			setPolling(false)
			setError(
				new ApiError(0, "missing_payment_id", "No payment id in the URL."),
			)
			return
		}

		let stopped = false
		let timer: number | undefined
		const controller = new AbortController()
		const startedAt = Date.now()

		const load = async (isBackground: boolean) => {
			if (!isBackground) setLoading(true)
			try {
				const next = await getPayment(paymentId, controller.signal)
				if (stopped) return
				setPayment(next)
				setError(null)
				setLoading(false)

				const withinBudget = Date.now() - startedAt < POLL_BUDGET_MS
				const keepGoing = shouldPollPayment(next) && withinBudget
				const waiting = keepGoing && isWaitingOnLeg(next)
				setPolling(waiting)
				if (keepGoing) {
					timer = window.setTimeout(
						() => void load(true),
						waiting ? POLL_INTERVAL_MS : FAST_POLL_MS,
					)
				}
			} catch (cause) {
				if (stopped || controller.signal.aborted) return
				setLoading(false)
				setPolling(false)
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

		void load(false)
		return () => {
			stopped = true
			controller.abort()
			if (timer !== undefined) window.clearTimeout(timer)
			setPolling(false)
		}
	}, [paymentId, refreshToken])

	return { payment, error, loading, polling, refresh }
}
