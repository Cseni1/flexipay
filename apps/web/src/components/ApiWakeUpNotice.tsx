import { API_GAVE_UP_MESSAGE, API_WAKE_UP_MESSAGE } from "../api/client"
import { Button } from "./ui"

type Props = {
	/** Manual retry (also resets auto-retry backoff). */
	onRetry: () => void
	/** Optional attempt counter for status text. */
	attempt?: number
	busy?: boolean
	/** True after all automatic wake-up retries have been tried. */
	exhausted?: boolean
}

/**
 * Friendly cold-start state for Render's free tier. Never shows raw JSON.
 */
export function ApiWakeUpNotice({
	onRetry,
	attempt = 0,
	busy = false,
	exhausted = false,
}: Props) {
	const title = exhausted ? API_GAVE_UP_MESSAGE : API_WAKE_UP_MESSAGE
	return (
		<div
			className="api-wakeup"
			role="status"
			aria-live="polite"
			data-testid="api-wakeup"
			data-exhausted={exhausted ? "true" : "false"}
		>
			<p className="api-wakeup__title">{title}</p>
			<p className="form-note">
				{exhausted
					? "Automatic retries have stopped. You can try again now."
					: busy
						? "Trying again…"
						: attempt > 0
							? `Automatic retry ${attempt} in progress. You can also retry now.`
							: "We will retry automatically. You can also retry now."}
			</p>
			<div className="form-actions">
				<Button
					type="button"
					variant="secondary"
					onClick={onRetry}
					disabled={busy}
					data-testid="api-wakeup-retry"
				>
					Retry
				</Button>
			</div>
		</div>
	)
}
