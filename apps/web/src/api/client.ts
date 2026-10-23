import {
	PaymentDetailSchema,
	PaymentSchema,
	QuoteSchema,
	type CreatePaymentRequest,
	type CreateQuoteRequest,
	type Payment,
	type PaymentDetail,
	type Quote,
	type RecipientKind,
} from "@flexipay/web-lib/contract"

// The web app only calls the v1 API (ARCHITECTURE §5, §10). Responses are validated with the
// merged A0 schemas; no parallel quote or payment DTO is defined here.

const baseUrl = (import.meta.env.PUBLIC_API_URL ?? "").replace(/\/+$/, "")
const apiKey = import.meta.env.PUBLIC_API_KEY?.trim()

interface Parser<T> {
	parse: (value: unknown) => T
}

export class ApiError extends Error {
	readonly status: number
	readonly code: string
	readonly details: unknown

	constructor(
		status: number,
		code: string,
		message: string,
		details?: unknown,
	) {
		super(message)
		this.name = "ApiError"
		this.status = status
		this.code = code
		this.details = details
	}

	/** 422 reasons are part of the documented error envelope (ARCHITECTURE §10). */
	get reasons(): string[] {
		const details = this.details
		if (Array.isArray(details)) {
			return details.filter((item): item is string => typeof item === "string")
		}
		if (details && typeof details === "object" && "reasons" in details) {
			const reasons = (details as { reasons?: unknown }).reasons
			return Array.isArray(reasons)
				? reasons.filter((item): item is string => typeof item === "string")
				: []
		}
		return []
	}
}

interface RequestOptions<T> {
	method?: "GET" | "POST"
	body?: unknown
	schema: Parser<T>
	idempotencyKey?: string
	signal?: AbortSignal
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null

async function request<T>(
	path: string,
	options: RequestOptions<T>,
): Promise<T> {
	const headers = new Headers({ Accept: "application/json" })
	if (options.body !== undefined)
		headers.set("Content-Type", "application/json")
	if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`)
	if (options.idempotencyKey)
		headers.set("Idempotency-Key", options.idempotencyKey)

	let response: Response
	try {
		response = await fetch(`${baseUrl}${path}`, {
			method: options.method ?? "GET",
			headers,
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: options.signal,
		})
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError")
			throw error
		throw new ApiError(
			0,
			"network_error",
			error instanceof Error ? error.message : "The API could not be reached.",
		)
	}

	const text = await response.text()
	let payload: unknown = null
	if (text) {
		try {
			payload = JSON.parse(text)
		} catch {
			throw new ApiError(
				response.status,
				"invalid_response",
				`The API returned a non-JSON response (HTTP ${response.status}).`,
			)
		}
	}

	if (!response.ok) {
		const record = isRecord(payload) ? payload : {}
		const code =
			typeof record.code === "string" ? record.code : `http_${response.status}`
		const message =
			typeof record.message === "string"
				? record.message
				: `API request failed (HTTP ${response.status}).`
		throw new ApiError(response.status, code, message, record.details)
	}

	try {
		return options.schema.parse(payload)
	} catch {
		throw new ApiError(
			response.status,
			"invalid_response",
			"The API response does not match the A0 contract.",
		)
	}
}

export const describeApiError = (error: ApiError): string =>
	[error.message, ...error.reasons].filter(Boolean).join(" ")

export const newIdempotencyKey = (prefix: string): string =>
	`${prefix}-${crypto.randomUUID()}`

export const createQuote = (
	input: CreateQuoteRequest,
	signal?: AbortSignal,
): Promise<Quote> =>
	request("/v1/quotes", {
		method: "POST",
		body: input,
		schema: QuoteSchema,
		idempotencyKey: newIdempotencyKey("quote"),
		signal,
	})

interface CreateRecipientInput {
	name: string
	kind: RecipientKind
	country: string
}

/** The existing CC0 route is not part of A0; only its id is needed by CreatePaymentRequest. */
const recipientIdSchema: Parser<{ id: string }> = {
	parse: (value) => {
		if (
			!isRecord(value) ||
			typeof value.id !== "string" ||
			value.id.length === 0
		) {
			throw new Error("recipient id missing")
		}
		return { id: value.id }
	},
}

export const createRecipient = (
	input: CreateRecipientInput,
	idempotencyKey: string,
	signal?: AbortSignal,
): Promise<{ id: string }> =>
	request("/v1/recipients", {
		method: "POST",
		body: input,
		schema: recipientIdSchema,
		idempotencyKey,
		signal,
	})

export const createPayment = (
	input: CreatePaymentRequest,
	idempotencyKey: string,
	signal?: AbortSignal,
): Promise<Payment> =>
	request("/v1/payments", {
		method: "POST",
		body: input,
		schema: PaymentSchema,
		idempotencyKey,
		signal,
	})

export const getPayment = (
	paymentId: string,
	signal?: AbortSignal,
): Promise<PaymentDetail> =>
	request(`/v1/payments/${encodeURIComponent(paymentId)}`, {
		schema: PaymentDetailSchema,
		signal,
	})

export const fundPayment = (
	paymentId: string,
	idempotencyKey: string,
	signal?: AbortSignal,
): Promise<Payment> =>
	request(`/v1/payments/${encodeURIComponent(paymentId)}/fund`, {
		method: "POST",
		body: {},
		schema: PaymentSchema,
		idempotencyKey,
		signal,
	})
