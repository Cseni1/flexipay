import {
	BatchSchema,
	ClaimAcceptRequestSchema,
	ClaimAcceptResponseSchema,
	ClaimViewSchema,
	CreateBatchRequestSchema,
	CreateEndpointRequestSchema,
	CreatePaymentRequestSchema,
	CreateQuoteRequestSchema,
	EndpointSchema,
	EventListResponseSchema,
	PaymentDetailSchema,
	PaymentSchema,
	QuoteSchema,
	SandboxAdvanceTimeRequestSchema,
	SandboxAdvanceTimeResponseSchema,
	SandboxFailNextRequestSchema,
	type Payment,
	type PaymentDetail,
	type Quote,
} from "@flexipay/domain"
import type { DemoEnv } from "./env.ts"
import { HttpClient, apiErrorCode, apiErrorMessage } from "./http.ts"
import { ApiRejection } from "./rejection.ts"
import type {
	AcceptInput,
	BatchRowInput,
	BatchView,
	ClaimView,
	DemoApi,
	EndpointInput,
	EndpointView,
	EventView,
	PaymentHandle,
	PaymentInput,
	PaymentView,
	QuoteInput,
	QuoteView,
	RecipientInput,
	RecipientView,
} from "./types.ts"

// Wire DemoApi to the merged A0/CC3b Zod schemas. Every request body and success response is
// parsed by its published schema; this file is the only place that maps the demo's semantic view
// onto wire shapes.

function reasonsFromBody(body: unknown): string[] {
	if (typeof body !== "object" || body === null) return []
	const record = body as Record<string, unknown>
	if (Array.isArray(record.reasons)) {
		return record.reasons.filter((r): r is string => typeof r === "string")
	}
	// Quote 422s publish the explanations in details.reasons; `message` is only the summary.
	const details = record.details
	if (typeof details === "object" && details !== null) {
		const nested = (details as Record<string, unknown>).reasons
		if (Array.isArray(nested)) {
			return nested.filter((r): r is string => typeof r === "string")
		}
	}
	if (typeof record.message === "string" && record.message.length > 0) {
		return [record.message]
	}
	return []
}

function mapLeg(leg: Payment["legs"][number]) {
	return {
		kind: leg.kind,
		rail: leg.rail,
		providerId: leg.providerId,
		amountIn: leg.amountIn,
		amountOut: leg.amountOut,
		status: leg.status,
		attempt: leg.attempt,
		...(leg.externalRef ? { externalRef: leg.externalRef } : {}),
		...(leg.lockTxRef ? { lockTxRef: leg.lockTxRef } : {}),
		...(leg.releaseTxRef ? { releaseTxRef: leg.releaseTxRef } : {}),
		...(leg.error
			? { error: { code: leg.error.code, message: leg.error.message } }
			: {}),
		simulated: leg.simulated,
	}
}

function mapPayment(p: Payment | PaymentDetail): PaymentView {
	const events =
		"events" in p && Array.isArray(p.events)
			? p.events.map((e) => ({
					type: e.type,
					createdAt: e.createdAt,
					paymentId: e.paymentId ?? undefined,
					snapshot: e.snapshot,
				}))
			: undefined
	return {
		id: p.id,
		status: p.status,
		legs: p.legs.map(mapLeg),
		delivery: p.delivery,
		...(p.externalId ? { externalId: p.externalId } : {}),
		quoteId: p.quoteId,
		...(p.batchId ? { batchId: p.batchId } : {}),
		...(events ? { events } : {}),
	}
}

function mapQuote(q: Quote): QuoteView {
	return {
		id: q.id,
		route: q.route.map((leg) => ({
			kind: leg.kind,
			rail: leg.rail,
			providerId: leg.providerId,
			amountIn: leg.amountIn,
			amountOut: leg.amountOut,
			simulated: leg.simulated,
		})),
		reasons: q.reasons,
		amount: { side: q.amount.side, value: q.amount.value },
		expectedReceive: q.expectedReceive,
		validUntil: q.validUntil,
		simulated: q.simulated,
		feeMode: q.feeMode,
		...(q.fxRate ? { fxRate: q.fxRate } : {}),
		fees: q.fees,
		alternatives: q.alternatives,
	}
}

function claimTokenFromHandle(url: string): string | undefined {
	const m = /\/v1\/claims\/([^/?#]+)/.exec(url)
	return m?.[1]
}

function mapBatch(batch: ReturnType<typeof BatchSchema.parse>): BatchView {
	return {
		id: batch.id,
		organizationId: batch.organizationId,
		status: batch.status,
		paymentIds: batch.paymentIds,
		totals: batch.totals,
		createdAt: batch.createdAt,
	}
}

export function loadDemoApi(env: DemoEnv): DemoApi {
	const http = new HttpClient(env.apiUrl, env.apiKey, env.timeoutMs)

	async function ok<T>(
		method: "GET" | "POST",
		path: string,
		options: {
			body?: unknown
			idempotencyKey?: string
			auth?: boolean
			parse: (body: unknown) => T
		},
	): Promise<T> {
		const res = await http.call(method, path, {
			body: options.body,
			idempotencyKey: options.idempotencyKey,
			auth: options.auth,
		})
		if (res.status < 200 || res.status >= 300) {
			throw new ApiRejection(res.status, {
				code: apiErrorCode(res.body),
				message: apiErrorMessage(res.body),
				reasons: reasonsFromBody(res.body),
			})
		}
		return options.parse(res.body)
	}

	return {
		async createRecipient(input: RecipientInput): Promise<RecipientView> {
			const body = await ok("POST", "/v1/recipients", {
				body: {
					name: input.name,
					kind: input.kind,
					country: input.country,
				},
				parse: (raw) => {
					const r = raw as { id: string; name: string }
					return { id: r.id, name: r.name }
				},
			})
			return body
		},

		async createEndpoint(input: EndpointInput): Promise<EndpointView> {
			const body = CreateEndpointRequestSchema.parse({
				recipientId: input.recipientId,
				type: input.type,
				country: input.country,
				currency: input.currency,
				network: input.network ?? null,
				details: input.details,
				simulated: input.simulated,
			})
			const endpoint = await ok("POST", "/v1/endpoints", {
				body,
				idempotencyKey: `endpoint:${input.recipientId}:${input.type}:${JSON.stringify(input.details)}`,
				parse: (raw) => EndpointSchema.parse(raw),
			})
			return {
				id: endpoint.id,
				recipientId: endpoint.recipientId,
				type: endpoint.type,
			}
		},

		async quote(input: QuoteInput): Promise<QuoteView> {
			const body = CreateQuoteRequestSchema.parse({
				source: {
					type: "bank_account",
					currency: "USD",
					country: "US",
				},
				destination: {
					type: input.destination.type,
					currency: input.destination.currency,
					country: input.destination.country,
					recipientKind: input.destination.recipientKind,
				},
				amount: {
					side: input.amountSide,
					value: input.amount,
				},
				// Required by CreateQuoteRequestSchema for settle routes (CCR-8); never defaulted here.
				feeMode: input.feeMode,
				policy: input.policy ?? "cheapest",
			})
			const q = await ok("POST", "/v1/quotes", {
				body,
				parse: (raw) => QuoteSchema.parse(raw),
			})
			return mapQuote(q)
		},

		async createPayment(input: PaymentInput): Promise<PaymentHandle> {
			const body = CreatePaymentRequestSchema.parse({
				quoteId: input.quoteId,
				recipientId: input.recipientId,
				externalId: input.externalId,
				delivery: input.delivery,
				profile: input.profile,
			})
			const payment = await ok("POST", "/v1/payments", {
				body,
				idempotencyKey: input.idempotencyKey ?? input.externalId,
				parse: (raw) => PaymentSchema.parse(raw),
			})
			const token = payment.claimLink
				? claimTokenFromHandle(payment.claimLink.url)
				: undefined
			return {
				payment: mapPayment(payment),
				...(token ? { claimToken: token } : {}),
			}
		},

		async fund(paymentId: string): Promise<PaymentView> {
			const payment = await ok("POST", `/v1/payments/${paymentId}/fund`, {
				parse: (raw) => PaymentSchema.parse(raw),
			})
			return mapPayment(payment)
		},

		async payment(paymentId: string): Promise<PaymentView> {
			const payment = await ok("GET", `/v1/payments/${paymentId}`, {
				parse: (raw) => PaymentDetailSchema.parse(raw),
			})
			return mapPayment(payment)
		},

		async events(paymentId: string): Promise<EventView[]> {
			const list = await ok("GET", "/v1/events", {
				parse: (raw) => EventListResponseSchema.parse(raw),
			})
			return list.events
				.filter((e) => e.paymentId === paymentId)
				.map((e) => ({
					type: e.type,
					createdAt: e.createdAt,
					paymentId: e.paymentId ?? undefined,
					snapshot: e.snapshot,
				}))
		},

		async createBatch(
			rows: BatchRowInput[],
			feeMode: QuoteInput["feeMode"],
		): Promise<BatchView> {
			const body = CreateBatchRequestSchema.parse({ feeMode, rows })
			const batch = await ok("POST", "/v1/batches", {
				body,
				parse: (raw) => BatchSchema.parse(raw),
			})
			return mapBatch(batch)
		},

		async batch(batchId: string): Promise<BatchView> {
			const batch = await ok("GET", `/v1/batches/${batchId}`, {
				parse: (raw) => BatchSchema.parse(raw),
			})
			return mapBatch(batch)
		},

		async claim(token: string): Promise<ClaimView> {
			const view = await ok("GET", `/v1/claims/${encodeURIComponent(token)}`, {
				auth: false,
				parse: (raw) => ClaimViewSchema.parse(raw),
			})
			return {
				status: view.status,
				amount: view.amount,
				allowedEndpointTypes: view.allowedDestinationTypes,
			}
		},

		async acceptClaim(token: string, input: AcceptInput): Promise<PaymentView> {
			const details = {
				...(input.details ?? {}),
				...(input.address ? { address: input.address } : {}),
			}
			const country =
				input.type === "crypto_wallet" || input.type === "crypto_custodial"
					? ""
					: "PH"
			const currency =
				input.type === "crypto_wallet" || input.type === "crypto_custodial"
					? "USDC"
					: "PHP"
			const body = ClaimAcceptRequestSchema.parse({
				endpoint: {
					type: input.type,
					country,
					currency,
					network:
						input.type === "crypto_wallet" || input.type === "crypto_custodial"
							? "stellar"
							: null,
					details,
					simulated: true,
				},
			})
			const accepted = await ok(
				"POST",
				`/v1/claims/${encodeURIComponent(token)}/accept`,
				{
					auth: false,
					body,
					parse: (raw) => ClaimAcceptResponseSchema.parse(raw),
				},
			)
			return this.payment(accepted.paymentId)
		},

		async failNext(providerId: string, count: number): Promise<void> {
			const body = SandboxFailNextRequestSchema.parse({
				providerId,
				count,
			})
			await ok("POST", "/v1/sandbox/fail-next", {
				body,
				parse: () => undefined,
			})
		},

		async advanceTime(seconds: number): Promise<void> {
			const body = SandboxAdvanceTimeRequestSchema.parse({ seconds })
			await ok("POST", "/v1/sandbox/advance-time", {
				body,
				parse: (raw) => SandboxAdvanceTimeResponseSchema.parse(raw),
			})
		},
	}
}
