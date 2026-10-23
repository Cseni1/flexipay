import type { ZodType } from "zod";
import {
	ClaimAcceptRequestSchema,
	ClaimAcceptResponseSchema,
	ClaimViewSchema,
} from "./claims.ts";
import { EventListResponseSchema } from "./events.ts";
import {
	CreatePaymentRequestSchema,
	PaymentDetailSchema,
	PaymentListResponseSchema,
	PaymentSchema,
} from "./payments.ts";
import { CreateQuoteRequestSchema, QuoteSchema } from "./quotes.ts";
import {
	SandboxFailNextRequestSchema,
	SandboxProviderHealthRequestSchema,
	SandboxResetRequestSchema,
} from "./sandbox.ts";

/**
 * A0 OpenAPI path stubs (DEV_PLAN A0). Request/response bodies for lanes C/D before CC3
 * mounts Express handlers. Not executable routes — never added to `ROUTES` / `createApp`.
 *
 * `success.schema` may be omitted when ARCHITECTURE names the path but no body/response
 * shape is accepted yet (e.g. advance-time pending integrator CCR).
 */
export interface ApiOpenApiStub {
	method: "get" | "post";
	path: string;
	summary: string;
	auth: "api_key" | "none";
	body?: ZodType;
	success: { status: 200 | 201; schema?: ZodType };
}

export const A0_OPENAPI_STUBS: readonly ApiOpenApiStub[] = [
	{
		method: "post",
		path: "/v1/quotes",
		summary: "Quote with route, fees, FX, validity, alternatives, reasons",
		auth: "api_key",
		body: CreateQuoteRequestSchema,
		success: { status: 201, schema: QuoteSchema },
	},
	{
		method: "post",
		path: "/v1/payments",
		summary: "Create a payment from a valid quote (direct or claim link)",
		auth: "api_key",
		body: CreatePaymentRequestSchema,
		success: { status: 201, schema: PaymentSchema },
	},
	{
		method: "get",
		path: "/v1/payments",
		summary: "List payments",
		auth: "api_key",
		success: { status: 200, schema: PaymentListResponseSchema },
	},
	{
		method: "get",
		path: "/v1/payments/{id}",
		summary: "Payment with legs and events",
		auth: "api_key",
		success: { status: 200, schema: PaymentDetailSchema },
	},
	{
		method: "post",
		path: "/v1/payments/{id}/fund",
		summary: "Mark funded (simulated collection); runs the legs",
		auth: "api_key",
		success: { status: 200, schema: PaymentSchema },
	},
	{
		method: "post",
		path: "/v1/payments/{id}/cancel",
		summary: "Cancel before processing",
		auth: "api_key",
		success: { status: 200, schema: PaymentSchema },
	},
	{
		method: "get",
		path: "/v1/events",
		summary: "Event log",
		auth: "api_key",
		success: { status: 200, schema: EventListResponseSchema },
	},
	{
		method: "get",
		path: "/v1/claims/{token}",
		summary: "Public: what is waiting for the recipient",
		auth: "none",
		success: { status: 200, schema: ClaimViewSchema },
	},
	{
		method: "post",
		path: "/v1/claims/{token}/accept",
		summary: "Public: recipient chooses an endpoint and accepts",
		auth: "none",
		body: ClaimAcceptRequestSchema,
		success: { status: 200, schema: ClaimAcceptResponseSchema },
	},
	{
		// Request from ARCHITECTURE §10 + CCR-4; no approved response body on main.
		method: "post",
		path: "/v1/sandbox/fail-next",
		summary: "Make the next count calls to a provider fail (also forced failure on or off)",
		auth: "api_key",
		body: SandboxFailNextRequestSchema,
		success: { status: 200 },
	},
	{
		// Request from ARCHITECTURE §10 + CCR-4; no approved response body on main.
		method: "post",
		path: "/v1/sandbox/provider-health",
		summary: "Mark a provider down or up",
		auth: "api_key",
		body: SandboxProviderHealthRequestSchema,
		success: { status: 200 },
	},
	{
		// Path only: ARCHITECTURE §10 names the route; body/response are not accepted on main.
		// Proposed (not contracted): POST { seconds: positive int } → { status: "ok", now: ISO-8601 }.
		method: "post",
		path: "/v1/sandbox/advance-time",
		summary: "Move the API clock (quote and claim expiry)",
		auth: "api_key",
		success: { status: 200 },
	},
	{
		// Empty request from ARCHITECTURE §10 / DEV_PLAN D2; no approved response body on main.
		method: "post",
		path: "/v1/sandbox/reset",
		summary: "Reset and reseed the demo",
		auth: "api_key",
		body: SandboxResetRequestSchema,
		success: { status: 200 },
	},
] as const;
