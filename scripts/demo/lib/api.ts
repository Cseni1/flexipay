import { existsSync } from "node:fs"
import {
	ClaimAcceptRequestSchema,
	ClaimAcceptResponseSchema,
	ClaimViewSchema,
	CreatePaymentRequestSchema,
	CreateQuoteRequestSchema,
	EventListResponseSchema,
	PaymentDetailSchema,
	PaymentSchema,
	QuoteSchema,
	SandboxFailNextRequestSchema,
	type Payment,
	type PaymentDetail,
	type Quote,
} from "@flexipay/domain"
import type { DemoEnv } from "./env.ts"
import { HttpClient, apiErrorCode, apiErrorMessage } from "./http.ts"
import { A0_DIR } from "./preflight.ts"
import { ApiRejection } from "./rejection.ts"
import { BlockedError } from "./report.ts"
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

// Wire DemoApi to A0 Zod schemas. Batches and endpoint-create are not in A0 — those calls
// stay BLOCKED with an owner. Recipients use the existing core route.

export const A0_REQUIREMENTS = [
	"A0 present: quotes, payments, fund, claims, events, sandbox fail-next",
	"Still absent from A0: POST/GET /v1/batches, POST /v1/endpoints (CC3)",
]

function requireA0(): void {
	if (!existsSync(A0_DIR)) {
		throw new BlockedError([
			{
				what: "A0 API contracts are absent (packages/domain/src/api)",
				owner: "Csaba (A0)",
				detail: A0_REQUIREMENTS.join(" | "),
			},
		])
	}
}

function reasonsFromBody(body: unknown): string[] {
	if (typeof body !== "object" || body === null) return []
	const record = body as Record<string, unknown>
	if (Array.isArray(record.reasons)) {
		return record.reasons.filter((r): r is string => typeof r === "string")
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

export function loadDemoApi(env: DemoEnv): DemoApi {
	requireA0()
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

		async createEndpoint(_input: EndpointInput): Promise<EndpointView> {
			throw new BlockedError([
				{
					what: "POST /v1/endpoints is not in A0 and has no Express route yet",
					owner: "Csaba (CC3b)",
					detail: A0_CONTRACT_ENDPOINTS,
				},
			])
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

		async createBatch(_rows: BatchRowInput[]): Promise<BatchView> {
			throw new BlockedError([
				{
					what: "POST /v1/batches is not contracted in A0",
					owner: "Csaba (A0 follow-up / CC3b)",
					detail: A0_CONTRACT_BATCHES,
				},
			])
		},

		async batch(_batchId: string): Promise<BatchView> {
			throw new BlockedError([
				{
					what: "GET /v1/batches/{id} is not contracted in A0",
					owner: "Csaba (A0 follow-up / CC3b)",
					detail: A0_CONTRACT_BATCHES,
				},
			])
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

		async advanceTime(_seconds: number): Promise<void> {
			await ok("POST", "/v1/sandbox/advance-time", {
				parse: () => undefined,
			})
		},
	}
}

const A0_CONTRACT_BATCHES =
	"A0 answers batch reasons via Quote.reasons only (see scripts/demo/lib/a0-answers.ts). Batch routes themselves are still CC3b."

const A0_CONTRACT_ENDPOINTS =
	"Endpoint create is listed in ARCHITECTURE §10 as to-build; A0 did not add a Zod schema. Recipients exist on core routes."
