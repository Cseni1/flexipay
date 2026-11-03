import { useEffect, useRef, useState } from "react"
import { isTransientApiError, type ApiError } from "../api/client"

/** Backoff while the free-tier API is cold (≈ up to one minute). */
const RETRY_DELAYS_MS = [3_000, 5_000, 8_000, 12_000, 15_000, 17_000]

type Options = {
	error: ApiError | null
	/** Skip auto-retry once real data is on screen. */
	hasData: boolean
	onRetry: () => void
	enabled?: boolean
}

/**
 * When a transient API error blocks the page, schedule automatic retries and
 * expose a manual retry that resets the schedule.
 */
export function useWakeUpRetry({
	error,
	hasData,
	onRetry,
	enabled = true,
}: Options): {
	waking: boolean
	attempt: number
	retryNow: () => void
} {
	const [attempt, setAttempt] = useState(0)
	const onRetryRef = useRef(onRetry)
	onRetryRef.current = onRetry

	const waking =
		enabled && !hasData && error !== null && isTransientApiError(error)

	useEffect(() => {
		if (!waking) {
			setAttempt(0)
			return
		}
		if (attempt >= RETRY_DELAYS_MS.length) return
		const delay = RETRY_DELAYS_MS[attempt] ?? 15_000
		const timer = window.setTimeout(() => {
			setAttempt((current) => current + 1)
			onRetryRef.current()
		}, delay)
		return () => window.clearTimeout(timer)
	}, [waking, attempt, error?.code, error?.status])

	const retryNow = () => {
		setAttempt(0)
		onRetry()
	}

	return { waking, attempt, retryNow }
}
