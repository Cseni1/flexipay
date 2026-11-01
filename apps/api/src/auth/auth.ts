import type { Request } from "express";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { fromNodeHeaders } from "better-auth/node";
import type { Db } from "../db.ts";
import { ApiError } from "../errors.ts";
import type { AuthConfig } from "./config.ts";
import { ensureOrganization, type OrgRef } from "./bootstrap.ts";

// TASK 06: Better Auth instance plus session -> organization resolution.
// Cookies: HttpOnly, SameSite=Lax, Secure in production. Sessions live in the database
// (no cookie cache), so deleting the row on sign-out or password reset revokes immediately and
// a replayed old cookie cannot authenticate.

export interface SessionIdentity {
	userId: string;
	email: string;
	name: string;
	org: OrgRef;
}

export function createAuth(db: Db, cfg: AuthConfig) {
	const auth = betterAuth({
		appName: "FlexiPay",
		baseURL: cfg.baseUrl,
		basePath: "/api/auth",
		secret: cfg.secret,
		trustedOrigins: cfg.trustedOrigins,
		database: prismaAdapter(db, { provider: "postgresql" }),
		user: { modelName: "authUser" },
		session: {
			modelName: "authSession",
			expiresIn: cfg.sessionTtl,
			updateAge: 60 * 60 * 24,
			// Deliberately no cookieCache: every request checks the database.
		},
		account: { modelName: "authAccount" },
		verification: { modelName: "authVerification" },
		emailAndPassword: {
			enabled: true,
			requireEmailVerification: true,
			minPasswordLength: 10,
			maxPasswordLength: 128,
			autoSignIn: false,
			resetPasswordTokenExpiresIn: 60 * 60,
			revokeSessionsOnPasswordReset: true,
			sendResetPassword: async ({ user, url }) => {
				await cfg.mailer.send({
					to: user.email,
					subject: "Reset your FlexiPay password",
					text: `Reset your password: ${url}\n\nIf you did not ask for this, ignore this email.`,
				});
			},
		},
		emailVerification: {
			sendOnSignUp: true,
			autoSignInAfterVerification: false,
			expiresIn: 60 * 60 * 24,
			sendVerificationEmail: async ({ user, url }) => {
				await cfg.mailer.send({
					to: user.email,
					subject: "Verify your FlexiPay email",
					text: `Confirm your email address: ${url}`,
				});
			},
		},
		// Our own limiter (rate-limit.ts) fronts /api/auth/*; Better Auth's is off to avoid
		// double counting and its skip-when-no-IP behaviour.
		rateLimit: { enabled: false },
		advanced: {
			useSecureCookies: cfg.secureCookies,
			cookiePrefix: "fp",
			defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
		},
		databaseHooks: {
			user: {
				create: {
					after: async (user) => {
						// Best effort; ensureOrganization also runs lazily on first session use.
						try {
							await ensureOrganization(db, user);
						} catch (err) {
							console.error("org bootstrap deferred", err);
						}
					},
				},
			},
		},
	});

	async function sessionIdentity(req: Request): Promise<SessionIdentity | null> {
		const s = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
		if (!s?.user || !s.session) return null;
		// Defence in depth; sign-in already refuses unverified users.
		if (!s.user.emailVerified) {
			throw new ApiError(403, "email_not_verified", "Verify your email address first");
		}
		const org = await ensureOrganization(db, s.user);
		return { userId: s.user.id, email: s.user.email, name: s.user.name, org };
	}

	return { auth, sessionIdentity };
}

export type AuthRuntime = ReturnType<typeof createAuth> & { config: AuthConfig };

export function createAuthRuntime(db: Db, config: AuthConfig): AuthRuntime {
	return { ...createAuth(db, config), config };
}
