import type { ZodType } from "zod";
import type { FlexiPayConfig } from "@flexipay/domain";
import type { Db } from "./db.ts";
import type { ApiRuntime } from "./runtime.ts";

// One route table drives Express and the OpenAPI document, so they cannot drift apart.

export interface AuthedOrg {
	id: string;
	name: string;
}

/** Who is calling: a server API key, or a signed-in customer (cookie session). */
export type Actor =
	| { kind: "api_key" }
	| { kind: "session"; userId: string; email: string; name: string };

export interface Ctx {
	db: Db;
	config: FlexiPayConfig;
	org?: AuthedOrg;
	actor?: Actor;
	runtime?: ApiRuntime;
}

export interface RouteDef<B = unknown, Q = unknown> {
	method: "get" | "post";
	/** OpenAPI style, e.g. /v1/payments/{id}. */
	path: string;
	summary: string;
	/**
	 * - "api_key": server API key only (sandbox/admin operations; a customer session is refused)
	 * - "customer": API key or customer session
	 * - "session": customer session only (API key management)
	 * - "none": public
	 */
	auth: "api_key" | "customer" | "session" | "none";
	/**
	 * HTTP Idempotency-Key:
	 * - omitted + api_key POST → org-scoped (optional key)
	 * - "claim" → public claim-token routes; required key; org = payment.organizationId
	 *   (handler uses withIdempotency; app.ts attaches req on ctx)
	 */
	idempotency?: "claim";
	body?: ZodType<B>;
	query?: ZodType<Q>;
	/** Success status code and response schema. */
	success: { status: 200 | 201 | 202; schema: ZodType };
	/** Optional alternate success (e.g. CCR-21 submit 202 pending). */
	extraResponses?: ReadonlyArray<{
		status: 202;
		description: string;
		schema: ZodType;
	}>;
	handler: (
		ctx: Ctx,
		input: { body: B; query: Q; params: Record<string, string> },
	) => Promise<unknown>;
}

/** Handler may return this to pick 200 vs 202 (submit pending). */
export type HttpRouteResult = {
	httpStatus: 200 | 202;
	body: unknown;
};

export function isHttpRouteResult(out: unknown): out is HttpRouteResult {
	return (
		typeof out === "object" &&
		out !== null &&
		"httpStatus" in out &&
		"body" in out &&
		((out as HttpRouteResult).httpStatus === 200 ||
			(out as HttpRouteResult).httpStatus === 202)
	);
}

export const defineRoute = <B, Q>(r: RouteDef<B, Q>): RouteDef<B, Q> => r;
