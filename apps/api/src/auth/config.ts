import { createConsoleMailer, createBrevoMailer, type Mailer } from "./mailer.ts";

// TASK 06: auth configuration from the environment. Fails closed: when anything required is
// missing, `ok` is false with a reason, and the API serves 503 on /api/auth/* and refuses
// cookie sessions. API-key access is unaffected. There is no default or fallback secret in
// production; a random per-process secret is generated only outside production (sessions then
// do not survive a restart, which is fine for dev).

export interface AuthConfig {
	secret: string;
	/** Public origin the browser sees (web app). Better Auth builds email links from it. */
	baseUrl: string;
	/** Origins allowed to send cookie-authenticated mutations (CSRF/Origin check). */
	trustedOrigins: string[];
	secureCookies: boolean;
	mailer: Mailer;
	/** Seconds. */
	sessionTtl: number;
}

export type AuthConfigResult =
	| { ok: true; config: AuthConfig }
	| { ok: false; reason: string };

const MIN_SECRET_LENGTH = 32;

export function loadAuthConfig(
	env: Record<string, string | undefined>,
	randomSecret: () => string,
): AuthConfigResult {
	const production = env.NODE_ENV === "production";

	let secret = env.BETTER_AUTH_SECRET;
	if (!secret) {
		if (production) return { ok: false, reason: "BETTER_AUTH_SECRET is not set" };
		secret = randomSecret();
	}
	if (secret.length < MIN_SECRET_LENGTH) {
		return {
			ok: false,
			reason: `BETTER_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
		};
	}

	const baseUrl = env.WEB_ORIGIN ?? (production ? undefined : "http://localhost:5173");
	if (!baseUrl) return { ok: false, reason: "WEB_ORIGIN is not set" };
	let baseOrigin: string;
	try {
		const u = new URL(baseUrl);
		if (production && u.protocol !== "https:") {
			return { ok: false, reason: "WEB_ORIGIN must be https in production" };
		}
		baseOrigin = u.origin;
	} catch {
		return { ok: false, reason: "WEB_ORIGIN is not a valid URL" };
	}

	const extra = (env.WEB_ORIGIN_EXTRA ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const trustedOrigins = new Set<string>([baseOrigin]);
	for (const o of extra) {
		try {
			const u = new URL(o);
			if (u.origin === "null" || o === "*") throw new Error("bad");
			trustedOrigins.add(u.origin);
		} catch {
			return { ok: false, reason: `WEB_ORIGIN_EXTRA has an invalid origin: ${o}` };
		}
	}

	let mailer: Mailer;
	if (env.BREVO_API_KEY) {
		if (!env.BREVO_SENDER_EMAIL) {
			return { ok: false, reason: "BREVO_SENDER_EMAIL is required with BREVO_API_KEY" };
		}
		mailer = createBrevoMailer(env.BREVO_API_KEY, env.BREVO_SENDER_EMAIL);
	} else if (env.FP_MAIL_DEV_CONSOLE === "1") {
		if (production) return { ok: false, reason: "console mail is not allowed in production" };
		mailer = createConsoleMailer();
	} else {
		return {
			ok: false,
			reason: "BREVO_API_KEY is not set (FP_MAIL_DEV_CONSOLE=1 only outside production)",
		};
	}

	return {
		ok: true,
		config: {
			secret,
			baseUrl: baseOrigin,
			trustedOrigins: [...trustedOrigins],
			secureCookies: production || baseOrigin.startsWith("https:"),
			mailer,
			sessionTtl: 60 * 60 * 24 * 7,
		},
	};
}
