import { useCallback, useEffect, useState } from "react"
import {
	ApiError,
	API_WAKE_UP_MESSAGE,
	getHealth,
	isAuthRequired,
	isTransientApiError,
	listCorridors,
} from "../api/client"

type Status = "checking" | "ok" | "auth" | "down" | "waking"

const LABEL: Record<Status, string> = {
	checking: "API…",
	ok: "API connected",
	auth: "API auth needed",
	down: "API unavailable",
	waking: "Waking API…",
}

const WAKE_DELAYS_MS = [3_000, 5_000, 8_000, 12_000, 15_000, 17_000]

export function ApiStatus() {
	const [status, setStatus] = useState<Status>("checking")
	const [attempt, setAttempt] = useState(0)

	const probe = useCallback(async (signal: AbortSignal) => {
		await getHealth(signal)
		await listCorridors(signal)
	}, [])

	useEffect(() => {
		const controller = new AbortController()
		let active = true
		let timer: number | undefined

		const run = async () => {
			if (active) setStatus((current) => (current === "ok" ? "ok" : "checking"))
			try {
				await probe(controller.signal)
				if (!active) return
				setStatus("ok")
				setAttempt(0)
			} catch (cause) {
				if (!active || controller.signal.aborted) return
				if (isAuthRequired(cause)) {
					setStatus("auth")
					return
				}
				if (isTransientApiError(cause) || cause instanceof ApiError) {
					setStatus("waking")
					if (attempt < WAKE_DELAYS_MS.length) {
						const delay = WAKE_DELAYS_MS[attempt] ?? 15_000
						timer = window.setTimeout(() => {
							setAttempt((n) => n + 1)
						}, delay)
					} else {
						setStatus("down")
					}
					return
				}
				setStatus("down")
			}
		}

		void run()
		return () => {
			active = false
			controller.abort()
			if (timer !== undefined) window.clearTimeout(timer)
		}
	}, [attempt, probe])

	const title = status === "waking" ? API_WAKE_UP_MESSAGE : LABEL[status]

	return (
		<p
			className={`api-status api-status--${status === "waking" ? "down" : status}`}
			aria-live="polite"
			title={title}
			data-testid="api-status"
			data-api-status={status}
		>
			<span className="api-status__dot" aria-hidden="true" />
			{LABEL[status]}
		</p>
	)
}
