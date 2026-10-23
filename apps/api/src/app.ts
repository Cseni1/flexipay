import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { ZodError } from "zod";
import type { FlexiPayConfig } from "@flexipay/domain";
import type { Db } from "./db.ts";
import { ApiError } from "./errors.ts";
import { sha256Hex } from "./ids.ts";
import { newId } from "./ids.ts";
import type { Ctx, RouteDef } from "./routes.ts";
import { batchRoutes } from "./routes/batches.ts";
import { claimRoutes } from "./routes/claims.ts";
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

async function withIdempotency<T>(
	db: Db,
	req: Request,
	orgId: string,
	run: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: unknown }> {
	const key = req.header("idempotency-key");
	if (!key) return run();
	const requestHash = sha256Hex(
		`${req.method} ${req.path} ${JSON.stringify(req.body ?? null)}`,
	);
	const found = await db.idempotencyRecord.findUnique({
		where: { organizationId_key: { organizationId: orgId, key } },
	});
	if (found) {
		if (found.requestHash !== requestHash) {
			throw new ApiError(
				409,
				"idempotency_conflict",
				"This Idempotency-Key was used with a different request",
			);
		}
		return { status: found.responseStatus, body: found.responseBody };
	}
	const result = await run();
	await db.idempotencyRecord
		.create({
			data: {
				id: newId("idm"),
				organizationId: orgId,
				key,
				requestHash,
				responseStatus: result.status,
				responseBody: result.body as object,
			},
		})
		.catch(() => {});
	return result;
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
					const ctx: Ctx = {
						db: deps.db,
						config: deps.config,
						runtime: deps.runtime,
					};
					if (route.auth === "api_key") ctx.org = await authenticate(deps.db, req);
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
