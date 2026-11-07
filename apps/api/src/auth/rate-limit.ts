import type { NextFunction, Request, Response } from "express";

// TASK 06: rate limiting for /api/auth/*. Fixed window per client address and bucket, in
// memory (single API instance). Behind a proxy set TRUST_PROXY_HOPS (hop count) so req.ip is the
// real client; otherwise the socket address is used. For several instances, replace the store
// with a shared one (Redis/Postgres); the interface is the `Map` below.

export interface Rule {
	/** Matches the path after /api/auth. */
	match: RegExp;
	bucket: string;
	max: number;
	windowMs: number;
}

export const DEFAULT_RULES: Rule[] = [
	{ match: /^\/sign-in\//, bucket: "sign-in", max: 10, windowMs: 15 * 60_000 },
	{ match: /^\/sign-up\//, bucket: "sign-up", max: 5, windowMs: 60 * 60_000 },
	{
		match: /^\/(request-password-reset|forget-password|send-verification-email|reset-password)/,
		bucket: "recovery",
		max: 5,
		windowMs: 60 * 60_000,
	},
	{ match: /^\//, bucket: "other", max: 120, windowMs: 60_000 },
];

export function createAuthRateLimiter(
	rules: Rule[] = DEFAULT_RULES,
	now: () => number = Date.now,
	/** Who a hit counts against; default the client address. */
	clientKey: (req: Request, rule: Rule) => string = (req) => req.ip ?? "unknown",
) {
	const hits = new Map<string, { count: number; resetAt: number }>();
	let lastSweep = now();

	return (req: Request, res: Response, next: NextFunction) => {
		const t = now();
		if (t - lastSweep > 60_000) {
			lastSweep = t;
			for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
		}
		const path = req.path;
		// Session reads are cheap and frequent; only throttle them via the generic bucket.
		const rule = rules.find((r) => r.match.test(path));
		if (!rule) return next();
		const key = `${clientKey(req, rule)}|${rule.bucket}`;
		let entry = hits.get(key);
		if (!entry || entry.resetAt <= t) {
			entry = { count: 0, resetAt: t + rule.windowMs };
			hits.set(key, entry);
		}
		entry.count += 1;
		if (entry.count > rule.max) {
			res.setHeader("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - t) / 1000))));
			res.status(429).json({ code: "rate_limited", message: "Too many attempts, try again later" });
			return;
		}
		next();
	};
}
