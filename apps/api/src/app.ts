import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { ZodError } from "zod";
import { toNodeHandler } from "better-auth/node";
import type { FlexiPayConfig } from "@flexipay/domain";
import type { Db } from "./db.ts";
import { ApiError } from "./errors.ts";
import { sha256Hex } from "./ids.ts";
import { withIdempotency } from "./idempotency.ts";
import { isHttpRouteResult, type Actor, type Ctx, type RouteDef } from "./routes.ts";
import { batchRoutes } from "./routes/batches.ts";
import { claimRoutes } from "./routes/claims.ts";
import { anchorClaimRoutes } from "./routes/anchor-claims.ts";
import { passkeyClaimRoutes, type CtxWithRequest } from "./routes/passkey-claims.ts";
import { coreRoutes } from "./routes/core.ts";
import { endpointRoutes } from "./routes/endpoints.ts";
import { eventRoutes } from "./routes/events.ts";
import { opsRoutes } from "./routes/ops.ts";
import { paymentRoutes } from "./routes/payments.ts";
import { quoteRoutes } from "./routes/quotes.ts";
import { sandboxRoutes } from "./routes/sandbox.ts";
import { solanaRoutes } from "./routes/solana.ts";
import { paymentRequestRoutes } from "./routes/payment-requests.ts";
import type { ApiRuntime } from "./runtime.ts";
import type { AuthRuntime } from "./auth/auth.ts";
import { createAuthRateLimiter } from "./auth/rate-limit.ts";
import { onrampRoutes } from "./routes/onramp.ts";
import { sessionRoutes } from "./routes/session.ts";

export const ROUTES: RouteDef<any, any>[] = [
	...coreRoutes,
	...opsRoutes,
	...sessionRoutes,
	...onrampRoutes,
	...endpointRoutes,
	...batchRoutes,
	...quoteRoutes,
	...paymentRoutes,
	...eventRoutes,
	...claimRoutes,
	...passkeyClaimRoutes,
	...anchorClaimRoutes,
	...solanaRoutes,
	...paymentRequestRoutes,
	...sandboxRoutes,
];

const toExpressPath = (p: string) => p.replace(/\{(\w+)\}/g, ":$1");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

async function authenticateKey(db: Db, header: string): Promise<Ctx["org"]> {
	const match = /^Bearer (\S+)$/.exec(header);
	if (!match) {
		throw new ApiError(
			401,
			"unauthorized",
			"Send an API key as: Authorization: Bearer <key>",
		);
	}
	const key = await db.apiKey.findUnique({
		where: { keyHash: sha256Hex(match[1]!) },
		include: { organization: true },
	});
	if (!key || key.revokedAt) {
		throw new ApiError(401, "unauthorized", "Unknown or revoked API key");
	}
	return { id: key.organization.id, name: key.organization.name };
}

/**
 * CSRF defence for cookie-authenticated mutations: the browser must send an Origin we trust.
 * API-key calls (Authorization header) are not cookie-borne and skip this.
 */
function assertTrustedOrigin(req: Request, trusted: readonly string[]) {
	if (SAFE_METHODS.has(req.method)) return;
	const origin = req.header("origin");
	if (!origin || !trusted.includes(origin)) {
		throw new ApiError(403, "forbidden_origin", "Request origin is not allowed");
	}
}

async function authenticate(
	deps: { db: Db; auth?: AuthRuntime },
	req: Request,
	mode: "api_key" | "customer" | "session",
): Promise<{ org: NonNullable<Ctx["org"]>; actor: Actor }> {
	const header = req.header("authorization");
	if (header !== undefined) {
		// An Authorization header always means API-key auth; a bad key never falls back to
		// the cookie, and a session-only route refuses keys.
		if (mode === "session") {
			throw new ApiError(401, "unauthorized", "This operation needs a signed-in customer session");
		}
		return { org: (await authenticateKey(deps.db, header))!, actor: { kind: "api_key" } };
	}
	if (mode === "api_key" || !deps.auth) {
		throw new ApiError(
			401,
			"unauthorized",
			mode === "api_key"
				? "Send an API key as: Authorization: Bearer <key>"
				: "Sign in or send an API key as: Authorization: Bearer <key>",
		);
	}
	assertTrustedOrigin(req, deps.auth.config.trustedOrigins);
	const id = await deps.auth.sessionIdentity(req);
	if (!id) throw new ApiError(401, "unauthorized", "Not signed in");
	return {
		org: id.org,
		actor: { kind: "session", userId: id.userId, email: id.email, name: id.name },
	};
}

export function createApp(deps: {
	db: Db;
	config: FlexiPayConfig;
	runtime: ApiRuntime;
	/** TASK 06: customer auth. Omitted/undefined = disabled (fail closed, API keys still work). */
	auth?: AuthRuntime;
	/** Enables /v1/sandbox/* (local dev/tests). Default false: those routes answer 404. */
	sandboxEnabled?: boolean;
	/** Hops of trusted reverse proxy, so req.ip is the real client (rate limiting). */
	trustProxy?: number;
}) {
	const app = express();
	app.disable("x-powered-by");
	if (deps.trustProxy) app.set("trust proxy", deps.trustProxy);

	// Better Auth reads the raw body itself: mount it before express.json.
	app.use("/api/auth", (_req, res, next) => {
		res.setHeader("Cache-Control", "no-store");
		next();
	});
	if (deps.auth) {
		// Our own Origin gate: every state-changing auth call must come from a trusted web origin,
		// independent of Better Auth's internal check (which is skipped in some environments).
		const trusted = deps.auth.config.trustedOrigins;
		app.use("/api/auth", (req, res, next) => {
			try {
				assertTrustedOrigin(req, trusted);
				next();
			} catch (err) {
				next(err);
			}
		});
		app.use("/api/auth", createAuthRateLimiter());
		app.all("/api/auth/*splat", toNodeHandler(deps.auth.auth));
	} else {
		app.all("/api/auth/*splat", (_req, res) => {
			res.status(503).json({
				code: "auth_unavailable",
				message: "Customer sign-in is not configured on this server",
			});
		});
	}
	app.use(express.json({ limit: "1mb" }));

	const router: Router = express.Router();
	for (const route of ROUTES) {
		router[route.method](
			toExpressPath(route.path),
			async (req: Request, res: Response, next: NextFunction) => {
				try {
					// Fail-closed gate, before authentication: a disabled sandbox does not reveal
					// itself to keys or sessions.
					if (route.gate === "sandbox" && deps.sandboxEnabled !== true) {
						throw new ApiError(404, "not_found", "No such route");
					}
					const ctx: CtxWithRequest = {
						db: deps.db,
						config: deps.config,
						runtime: deps.runtime,
					};
					if (route.auth !== "none") {
						const a = await authenticate(deps, req, route.auth);
						ctx.org = a.org;
						ctx.actor = a.actor;
					}
					if (route.idempotency === "claim") ctx.req = req;
					const run = async () => {
						const body = route.body ? route.body.parse(req.body ?? {}) : undefined;
						const query = route.query ? route.query.parse(req.query) : undefined;
						const out = await route.handler(ctx, {
							body,
							query,
							params: req.params as Record<string, string>,
						});
						if (isHttpRouteResult(out)) {
							const pendingSchema = route.extraResponses?.find(
								(e) => e.status === out.httpStatus,
							)?.schema;
							const schema =
								out.httpStatus === route.success.status
									? route.success.schema
									: pendingSchema;
							if (!schema) {
								throw new ApiError(
									500,
									"internal_error",
									`no response schema for HTTP ${out.httpStatus}`,
								);
							}
							return {
								status: out.httpStatus,
								body: schema.parse(out.body),
							};
						}
						return {
							status: route.success.status as number,
							body: route.success.schema.parse(out),
						};
					};
					const result =
						route.method === "post" && ctx.org
							? await withIdempotency(deps.db, req, ctx.org.id, run)
							: await run();
					res.status(result.status).json(result.body);
				} catch (err) {
					next(err);
				}
			},
		);
	}
	app.use(router);

	app.use((_req, res) => {
		res.status(404).json({ code: "not_found", message: "No such route" });
	});

	app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
		if (err instanceof ApiError) {
			res.status(err.status).json({
				code: err.code,
				message: err.message,
				...(err.details ? { details: err.details } : {}),
			});
		} else if (err instanceof ZodError) {
			res.status(400).json({
				code: "validation_error",
				message: "Invalid request",
				details: err.issues,
			});
		} else if (err instanceof SyntaxError) {
			res.status(400).json({
				code: "invalid_json",
				message: "Request body is not valid JSON",
			});
		} else {
			console.error(err);
			res.status(500).json({
				code: "internal_error",
				message: "Something went wrong",
			});
		}
	});

	return app;
}
