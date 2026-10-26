import { type Payment } from "@flexipay/web-lib/contract"
import { useCallback, useEffect, useState } from "react"
import { ApiError, listPayments } from "../api/client"

const MOVING = new Set(["funded", "processing", "refunding"])
const POLL_INTERVAL_MS = 4000

interface PaymentListState {
	payments: Payment[]
	error: ApiError | null
	loading: boolean
	refresh: () => void
}

/** Loads the payment history; polls only while something is still moving. */
export function usePaymentList(): PaymentListState {
	const [payments, setPayments] = useState<Payment[]>([])
	const [error, setError] = useState<ApiError | null>(null)
	const [loading, setLoading] = useState(true)
	const [token, setToken] = useState(0)
	const refresh = useCallback(() => setToken((value) => value + 1), [])

	useEffect(() => {
		let stopped = false
		let timer: number | undefined
		const controller = new AbortController()
		const load = async () => {
			try {
				const next = await listPayments(controller.signal)
				if (stopped) return
				setPayments(next.payments)
				setError(null)
				setLoading(false)
				if (next.payments.some((payment) => MOVING.has(payment.status))) {
					timer = window.setTimeout(load, POLL_INTERVAL_MS)
				}
			} catch (cause) {
				if (stopped || controller.signal.aborted) return
				setError(
					cause instanceof ApiError
						? cause
						: new ApiError(0, "network_error", "The API could not be reached."),
				)
				setLoading(false)
			}
		}
		void load()
		return () => {
			stopped = true
			controller.abort()
			if (timer !== undefined) window.clearTimeout(timer)
		}
	}, [token])

	return { payments, error, loading, refresh }
}
