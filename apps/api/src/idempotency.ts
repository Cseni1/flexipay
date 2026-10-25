import type { Request } from "express";
import type { Db } from "./db.ts";
import { ApiError } from "./errors.ts";
import { newId, sha256Hex } from "./ids.ts";

/**
 * HTTP Idempotency-Key helper (CCR-21).
 * requestHash = sha256(method + " " + path + " " + JSON.stringify(body)) — never stores bodies.
 * Scope is organizationId (for public passkey routes: claim payment's org).
 */
export async function withIdempotency<T>(
	db: Db,
	req: Request,
	orgId: string,
	run: () => Promise<{ status: number; body: T }>,
	opts?: {
		/** When true, missing Idempotency-Key → 400 (public passkey deploy/submit). */
		required?: boolean;
		/**
		 * Before returning a cached body: re-validate claim/org binding.
		 * Throw ApiError to refuse foreign/stale cache.
		 */
		beforeReturnCache?: () => Promise<void>;
		/**
		 * Transform body before IdempotencyRecord persistence (CCR-22: strip
		 * interactiveUrl / JWT so the cache never holds the raw hosted URL).
		 * The live first response still returns the unsanitised `result.body`.
		 */
		cacheBody?: (body: T) => unknown;
	},
): Promise<{ status: number; body: unknown }> {
	const key = req.header("idempotency-key");
	if (!key) {
		if (opts?.required) {
			throw new ApiError(
				400,
				"missing_idempotency_key",
				"Idempotency-Key header is required",
			);
		}
		return run();
	}
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
		if (opts?.beforeReturnCache) await opts.beforeReturnCache();
		return { status: found.responseStatus, body: found.responseBody };
	}
	const result = await run();
	const storedBody = opts?.cacheBody
		? opts.cacheBody(result.body)
		: result.body;
	await db.idempotencyRecord
		.create({
			data: {
				id: newId("idm"),
				organizationId: orgId,
				key,
				requestHash,
				responseStatus: result.status,
				responseBody: storedBody as object,
			},
		})
		.catch(() => {});
	return result;
}
