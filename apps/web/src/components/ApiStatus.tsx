import { useEffect, useState } from "react"
import {
	ApiError,
	getHealth,
	isAuthRequired,
	listCorridors,
} from "../api/client"

type Status = "checking" | "ok" | "auth" | "down"

const LABEL: Record<Status, string> = {
	checking: "API…",
	ok: "API connected",
	auth: "API auth needed",
	down: "API unavailable",
}

export function ApiStatus() {
	const [status, setStatus] = useState<Status>("checking")

	useEffect(() => {
		const controller = new AbortController()
		let active = true

		const probe = async () => {
			try {
				await getHealth(controller.signal)
				// Corridors confirms the Vite proxy can authenticate protected routes.
				await listCorridors(controller.signal)
				if (active) setStatus("ok")
			} catch (cause) {
				if (!active || controller.signal.aborted) return
				if (isAuthRequired(cause)) {
					setStatus("auth")
					return
				}
				if (cause instanceof ApiError && cause.code === "network_error") {
					setStatus("down")
					return
				}
				setStatus("down")
			}
		}

		void probe()
		return () => {
			active = false
			controller.abort()
		}
	}, [])

	return (
		<p
			className={`api-status api-status--${status}`}
			role="status"
			data-testid="api-status"
			data-api-status={status}
		>
			<span className="api-status__dot" aria-hidden="true" />
			{LABEL[status]}
		</p>
	)
}
