import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { ZodError } from "zod";
import type { FlexiPayConfig } from "@flexipay/domain";
import type { Db } from "./db.ts";
import { ApiError } from "./errors.ts";
import { sha256Hex } from "./ids.ts";
import { withIdempotency } from "./idempotency.ts";
import type { Ctx, RouteDef } from "./routes.ts";
import { batchRoutes } from "./routes/batches.ts";
import { claimRoutes } from "./routes/claims.ts";
import { passkeyClaimRoutes, type CtxWithRequest } from "./routes/passkey-claims.ts";
import { coreRoutes } from "./routes/core.ts";
import { endpointRoutes } from "./routes/endpoints.ts";
import { eventRoutes } from "./routes/events.ts";
import { paymentRoutes } from "./routes/payments.ts";
import { quoteRoutes } from "./routes/quotes.ts";
import { sandboxRoutes } from "./routes/sandbox.ts";
import type { ApiRuntime } from "./runtime.ts";

export const ROUTES: RouteDef<any, any>[] = [
	...coreRoutes,
	...endpointRoutes,
	...batchRoutes,
	...quoteRoutes,
	...paymentRoutes,
	...eventRoutes,
	...claimRoutes,
	...passkeyClaimRoutes,
	...sandboxRoutes,
];

const toExpressPath = (p: string) => p.replace(/\{(\w+)\}/g, ":$1");

async function authenticate(db: Db, req: Request): Promise<Ctx["org"]> {
	const header = req.header("authorization") ?? "";
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

export function createApp(deps: {
	db: Db;
	config: FlexiPayConfig;
	runtime: ApiRuntime;
}) {
	const app = express();
	app.disable("x-powered-by");
	app.use(express.json({ limit: "1mb" }));

	const router: Router = express.Router();
	for (const route of ROUTES) {
		router[route.method](
			toExpressPath(route.path),
			async (req: Request, res: Response, next: NextFunction) => {
				try {
					const ctx: CtxWithRequest = {
						db: deps.db,
						config: deps.config,
						runtime: deps.runtime,
					};
					if (route.auth === "api_key") ctx.org = await authenticate(deps.db, req);
					if (route.idempotency === "claim") ctx.req = req;
					const run = async () => {
						const body = route.body ? route.body.parse(req.body ?? {}) : undefined;
						const query = route.query ? route.query.parse(req.query) : undefined;
						const out = await route.handler(ctx, {
							body,
							query,
							params: req.params as Record<string, string>,
						});
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
