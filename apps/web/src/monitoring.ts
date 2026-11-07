/**
 * Browser error monitoring (docs/PLATFORM_TRACKER.md 2.1). Off unless VITE_SENTRY_DSN is set;
 * Sentry is loaded lazily only then, so the bundle does not grow for everyone else.
 */
export function initMonitoring(env: {
	VITE_SENTRY_DSN?: string
	MODE?: string
}): void {
	const dsn = env.VITE_SENTRY_DSN?.trim()
	if (!dsn) return
	void import("@sentry/react").then((Sentry) => {
		Sentry.init({
			dsn,
			environment: env.MODE === "production" ? "sandbox" : (env.MODE ?? "dev"),
			tracesSampleRate: 0,
		})
	})
}
