import type { ZodType } from "zod";
import {
	BatchSchema,
	CreateBatchRequestSchema,
} from "./batches.ts";
import {
	AnchorIndicativePriceRequestSchema,
	AnchorIndicativePriceResponseSchema,
	AnchorPayPendingResponseSchema,
	AnchorPayRequestSchema,
	AnchorPayResponseSchema,
	AnchorWithdrawRequestSchema,
	AnchorWithdrawResponseSchema,
	AnchorWithdrawStatusResponseSchema,
	ClaimAcceptRequestSchema,
	ClaimAcceptResponseSchema,
	ClaimViewSchema,
	PasskeyDeployRequestSchema,
	PasskeyDeployResponseSchema,
	PasskeyPrepareRequestSchema,
	PasskeyPrepareResponseSchema,
	PasskeySubmitPendingResponseSchema,
	PasskeySubmitRequestSchema,
	PasskeySubmitResponseSchema,
} from "./claims.ts";
import {
	CreateEndpointRequestSchema,
	EndpointListResponseSchema,
	EndpointSchema,
} from "./endpoints.ts";
import { EventListResponseSchema } from "./events.ts";
import {
	CreatePaymentRequestSchema,
	PaymentDetailSchema,
	PaymentListResponseSchema,
	PaymentSchema,
} from "./payments.ts";
import { CreateQuoteRequestSchema, QuoteSchema } from "./quotes.ts";
import {
	SandboxAdvanceTimeRequestSchema,
	SandboxAdvanceTimeResponseSchema,
	SandboxFailNextRequestSchema,
	SandboxProviderHealthRequestSchema,
	SandboxResetRequestSchema,
} from "./sandbox.ts";

/**
 * A0 OpenAPI path stubs (DEV_PLAN A0). Request/response bodies for lanes C/D before CC3
 * mounts Express handlers. Not executable routes — never added to `ROUTES` / `createApp`.
 *
 * `success.schema` may be omitted when ARCHITECTURE names the path but no body/response
 * shape is accepted yet.
 */
export interface ApiOpenApiStub {
	method: "get" | "post";
	path: string;
	summary: string;
	auth: "api_key" | "none";
	body?: ZodType;
	success: { status: 200 | 201 | 202; schema?: ZodType };
	/** Extra documented responses (e.g. CCR-21 submit 202 pending). */
	extraResponses?: ReadonlyArray<{
		status: 202;
		description: string;
		schema: ZodType;
	}>;
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
		method: "post",
		path: "/v1/endpoints",
		summary: "Create a payout endpoint for a recipient (CCR-16)",
		auth: "api_key",
		body: CreateEndpointRequestSchema,
		success: { status: 201, schema: EndpointSchema },
	},
	{
		method: "get",
		path: "/v1/endpoints",
		summary: "List endpoints (optional recipientId filter) (CCR-16)",
		auth: "api_key",
		success: { status: 200, schema: EndpointListResponseSchema },
	},
	{
		method: "post",
		path: "/v1/batches",
		summary: "Create a batch of payments via the existing payment engine (CCR-18)",
		auth: "api_key",
		body: CreateBatchRequestSchema,
		success: { status: 201, schema: BatchSchema },
	},
	{
		method: "get",
		path: "/v1/batches/{id}",
		summary: "Batch with payment ids and totals (CCR-18)",
		auth: "api_key",
		success: { status: 200, schema: BatchSchema },
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
		// CCR-21 ACK'd — passkey wallet deploy (M2). Mounted on event/csaba-cursor/m2-passkey.
		method: "post",
		path: "/v1/claims/{token}/passkey/deploy",
		summary:
			"Public: submit passkey-kit createWallet carrier; backend pays with FP_PAYER_DEMO",
		auth: "none",
		body: PasskeyDeployRequestSchema,
		success: { status: 200, schema: PasskeyDeployResponseSchema },
	},
	{
		// CCR-21 ACK'd — prepare (M2). Mounted on event/csaba-cursor/m2-passkey.
		method: "post",
		path: "/v1/claims/{token}/passkey/prepare",
		summary: "Public: build vault claim auth entries for a C… passkey wallet",
		auth: "none",
		body: PasskeyPrepareRequestSchema,
		success: { status: 200, schema: PasskeyPrepareResponseSchema },
	},
	{
		// CCR-21 ACK'd — submit (M2). 200 + releaseTxRef / 202 pending.
		method: "post",
		path: "/v1/claims/{token}/passkey/submit",
		summary:
			"Public: submit passkey-signed claim auth; 200 released / 202 pending",
		auth: "none",
		body: PasskeySubmitRequestSchema,
		success: { status: 200, schema: PasskeySubmitResponseSchema },
		extraResponses: [
			{
				status: 202,
				description:
					"Release tx persisted or awaiting confirmation; Leg.releaseTxRef not written yet",
				schema: PasskeySubmitPendingResponseSchema,
			},
		],
	},
	{
		// CCR-22 — reference-anchor claim HTTP (M1). Mounted on event/csaba-cursor/m1-anchor-api.
		method: "post",
		path: "/v1/claims/{token}/anchor/indicative-price",
		summary:
			"Public: SEP-38 indicative withdraw price (context=sep6; not a binding quote)",
		auth: "none",
		body: AnchorIndicativePriceRequestSchema,
		success: { status: 200, schema: AnchorIndicativePriceResponseSchema },
	},
	{
		// CCR-22 — start SEP-24 interactive withdraw after vault release to classic G….
		method: "post",
		path: "/v1/claims/{token}/anchor/withdraw",
		summary:
			"Public: start reference-anchor SEP-24 withdraw; first response may include interactiveUrl",
		auth: "none",
		body: AnchorWithdrawRequestSchema,
		success: { status: 200, schema: AnchorWithdrawResponseSchema },
	},
	{
		// CCR-22 — poll SEP-24 withdraw status (read-only; separate refs).
		method: "get",
		path: "/v1/claims/{token}/anchor/withdraw/{anchorTxId}",
		summary: "Public: read-only SEP-24 withdraw status for this claim's anchorTxId",
		auth: "none",
		success: { status: 200, schema: AnchorWithdrawStatusResponseSchema },
	},
	{
		// CCR-22 — custodial classic memo payment after interactive KYC.
		method: "post",
		path: "/v1/claims/{token}/anchor/withdraw/{anchorTxId}/pay",
		summary:
			"Public: submit classic memo payment to anchor (persist-before-send); 200/202",
		auth: "none",
		body: AnchorPayRequestSchema,
		success: { status: 200, schema: AnchorPayResponseSchema },
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
		// CCR-6 accepted: API clock only.
		method: "post",
		path: "/v1/sandbox/advance-time",
		summary: "Move the API clock (quote and claim expiry)",
		auth: "api_key",
		body: SandboxAdvanceTimeRequestSchema,
		success: { status: 200, schema: SandboxAdvanceTimeResponseSchema },
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
