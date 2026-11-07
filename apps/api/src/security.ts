import type { Express, NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { createAuthRateLimiter, type Rule } from "./auth/rate-limit.ts";
import { sha256Hex } from "./ids.ts";

// Security hardening (docs/PLATFORM_TRACKER.md section 4): response headers and a rate limit
// on the whole /v1 API.

/** API responses are JSON: nothing may run, load or frame. /docs needs Scalar from jsDelivr. */
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const DOCS_CSP = [
	"default-src 'none'",
	"script-src https://cdn.jsdelivr.net 'unsafe-inline' 'unsafe-eval'",
	"style-src 'self' https://cdn.jsdelivr.net https://fonts.googleapis.com 'unsafe-inline'",
	"font-src https://cdn.jsdelivr.net https://fonts.gstatic.com data:",
	"img-src 'self' https: data:",
	"connect-src 'self'",
	"worker-src blob:",
	"frame-ancestors 'none'",
	"base-uri 'none'",
	"form-action 'none'",
].join("; ");

export function mountSecurityHeaders(app: Express): void {
	app.use(
		helmet({
			contentSecurityPolicy: false,
			// The web app reaches the API through its own origin (Vercel rewrite); docs load the
			// spec from the same origin.
			crossOriginResourcePolicy: { policy: "same-origin" },
			strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true },
			referrerPolicy: { policy: "no-referrer" },
		}),
	);
	app.use((req: Request, res: Response, next: NextFunction) => {
		res.setHeader("Content-Security-Policy", req.path === "/docs" ? DOCS_CSP : API_CSP);
		// Payment, recipient and bank data must never sit in a shared or browser cache.
		if (req.path.startsWith("/v1/")) res.setHeader("Cache-Control", "no-store");
		next();
	});
}

/**
 * Per-caller budget on /v1 (paths are relative to /v1). Public claim routes (no auth, token in
 * the URL) count per client address; everything else counts per credential (API key or session
 * cookie), so customers behind the web app's shared proxy address do not share one budget.
 */
export const API_RULES: Rule[] = [
	{ match: /^\/claims\//, bucket: "claims", max: 300, windowMs: 60_000 },
	{ match: /^\//, bucket: "api", max: 600, windowMs: 60_000 },
];

function credentialKey(req: Request, rule: Rule): string {
	const ip = req.ip ?? "unknown";
	if (rule.bucket === "claims") return `ip:${ip}`;
	const authz = req.header("authorization");
	if (authz) return `key:${sha256Hex(authz)}`;
	const cookie = req.header("cookie");
	if (cookie && /session_token=/.test(cookie)) return `cookie:${sha256Hex(cookie)}`;
	return `ip:${ip}`;
}

export function createApiRateLimiter(rules: Rule[] = API_RULES, now: () => number = Date.now) {
	return createAuthRateLimiter(rules, now, credentialKey);
}
