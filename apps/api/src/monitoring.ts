/**
 * Error monitoring (docs/PLATFORM_TRACKER.md 2.1). Off unless SENTRY_DSN is set, and Sentry is
 * only loaded then. Never sends request bodies or headers (bank details, keys stay out).
 */
export async function initMonitoring(env: Record<string, string | undefined> = process.env): Promise<boolean> {
	const dsn = env.SENTRY_DSN?.trim();
	if (!dsn) return false;
	const Sentry = await import("@sentry/node");
	Sentry.init({
		dsn,
		environment: env.SENTRY_ENVIRONMENT?.trim() || "sandbox",
		tracesSampleRate: 0,
		beforeSend(event) {
			if (event.request) {
				delete event.request.data;
				delete event.request.headers;
				delete event.request.cookies;
			}
			return event;
		},
	});
	return true;
}
