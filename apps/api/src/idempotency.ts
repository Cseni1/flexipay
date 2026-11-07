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
	const cached = async () => {
		const found = await db.idempotencyRecord.findUnique({
			where: { organizationId_key: { organizationId: orgId, key } },
		});
		if (!found) return null;
		if (found.requestHash !== requestHash) {
			throw new ApiError(
				409,
				"idempotency_conflict",
				"This Idempotency-Key was used with a different request",
			);
		}
		// responseStatus 0 marks a request still running under this key (claimed below).
		if (found.responseStatus === 0) {
			throw new ApiError(
				409,
				"idempotency_in_progress",
				"A request with this Idempotency-Key is still being processed; retry shortly",
			);
		}
		if (opts?.beforeReturnCache) await opts.beforeReturnCache();
		return { status: found.responseStatus, body: found.responseBody };
	};
	const hit = await cached();
	if (hit) return hit as { status: number; body: unknown };

	// Claim the key before running, so concurrent requests with the same key cannot all run the
	// handler (test audit 7 Nov: 4 parallel POST /v1/payments made 3 payments). The unique
	// (organizationId, key) index lets exactly one claim win.
	const claimId = newId("idm");
	const claimed = await db.idempotencyRecord
		.create({
			data: {
				id: claimId,
				organizationId: orgId,
				key,
				requestHash,
				responseStatus: 0,
				responseBody: {},
			},
		})
		.then(() => true)
		.catch(() => false);
	if (!claimed) {
		const other = await cached();
		if (other) return other as { status: number; body: unknown };
		throw new ApiError(
			409,
			"idempotency_in_progress",
			"A request with this Idempotency-Key is still being processed; retry shortly",
		);
	}

	const release = () =>
		db.idempotencyRecord.delete({ where: { id: claimId } }).catch(() => {});
	let result: Awaited<ReturnType<typeof run>>;
	try {
		result = await run();
	} catch (e) {
		await release();
		throw e;
	}
	// 202 means "not finished, retry with the same key": never replay it (test audit 7 Nov).
	if (result.status === 202) {
		await release();
		return result;
	}
	const storedBody = opts?.cacheBody
		? opts.cacheBody(result.body)
		: result.body;
	await db.idempotencyRecord
		.update({
			where: { id: claimId },
			data: {
				responseStatus: result.status,
				responseBody: storedBody as object,
			},
		})
		.catch(() => {});
	return result;
}
