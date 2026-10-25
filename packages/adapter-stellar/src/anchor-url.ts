/**
 * Evidence sanitisation: hosted SEP-24 URLs and auth challenges may carry session
 * tokens. Never write raw interactive URLs or JWTs into evidence files.
 */

const SENSITIVE_QUERY = new Set([
	"token",
	"jwt",
	"access_token",
	"id_token",
	"session",
	"code",
	"signature",
]);

/**
 * Returns origin + pathname only, stripping query and hash. Invalid URLs become
 * a placeholder so evidence never embeds a half-parsed secret.
 */
export function sanitiseHostedUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return "[invalid-url]";
	}
}

/**
 * Redacts known sensitive query keys but keeps non-secret params (e.g. asset).
 * Prefer {@link sanitiseHostedUrl} for evidence; use this when debugging locally.
 */
export function redactUrlQuery(url: string): string {
	try {
		const parsed = new URL(url);
		for (const key of [...parsed.searchParams.keys()]) {
			if (SENSITIVE_QUERY.has(key.toLowerCase())) {
				parsed.searchParams.set(key, "[redacted]");
			}
		}
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return "[invalid-url]";
	}
}

/** Mask a JWT or opaque bearer for logs: keep length + first/last 4 chars. */
export function maskBearerToken(token: string): string {
	const t = token.trim();
	if (t.length <= 12) return "[redacted-token]";
	return `${t.slice(0, 4)}…${t.slice(-4)} (len=${t.length})`;
}
