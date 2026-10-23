import {
	ClaimAcceptRequestSchema,
	ClaimAcceptResponseSchema,
	ClaimViewSchema,
	type ClaimAcceptRequest,
	type ClaimAcceptResponse,
	type ClaimView,
} from "@flexipay/web-lib/claim-contract"

// Public claim routes are same-origin. The raw claim token comes from the URL and is used
// only in the request path: it is never logged, stored in browser storage or sent elsewhere.

export class ClaimApiError extends Error {
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
		this.name = "ClaimApiError"
		this.status = status
		this.code = code
		this.details = details
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null

const claimMessage = (status: number): string => {
	if (status === 404) return "This claim link is invalid or no longer exists."
	if (status === 409)
		return "This claim cannot be accepted in its current state. Refresh the claim first."
	if (status === 422) return "The claim endpoint was not accepted by the API."
	return "The claim could not be loaded."
}

interface ClaimRequestOptions<T> {
	method?: "GET" | "POST"
	body?: unknown
	schema: { parse: (value: unknown) => T }
	idempotencyKey?: string
	signal?: AbortSignal
}

async function claimRequest<T>(
	path: string,
	options: ClaimRequestOptions<T>,
): Promise<T> {
	const headers = new Headers({ Accept: "application/json" })
	if (options.body !== undefined)
		headers.set("Content-Type", "application/json")
	if (options.idempotencyKey)
		headers.set("Idempotency-Key", options.idempotencyKey)

	let response: Response
	try {
		response = await fetch(path, {
			method: options.method ?? "GET",
			headers,
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: options.signal,
		})
	} catch (cause) {
		if (cause instanceof DOMException && cause.name === "AbortError")
			throw cause
		throw new ClaimApiError(
			0,
			"network_error",
			"The claim API could not be reached.",
		)
	}

	const text = await response.text()
	let payload: unknown = null
	if (text) {
		try {
			payload = JSON.parse(text)
		} catch {
			throw new ClaimApiError(
				response.status,
				"invalid_response",
				`The claim API returned a non-JSON response (HTTP ${response.status}).`,
			)
		}
	}

	if (!response.ok) {
		const record = isRecord(payload) ? payload : {}
		throw new ClaimApiError(
			response.status,
			typeof record.code === "string" ? record.code : `http_${response.status}`,
			typeof record.message === "string"
				? record.message
				: claimMessage(response.status),
			record.details,
		)
	}

	try {
		return options.schema.parse(payload)
	} catch {
		throw new ClaimApiError(
			response.status,
			"invalid_response",
			"The claim API response does not match the A0 contract.",
		)
	}
}

const tokenPath = (token: string): string =>
	`/v1/claims/${encodeURIComponent(token)}`

export const getClaim = (
	token: string,
	signal?: AbortSignal,
): Promise<ClaimView> =>
	claimRequest(tokenPath(token), {
		schema: ClaimViewSchema,
		signal,
	})

export const acceptClaim = (
	token: string,
	input: ClaimAcceptRequest,
	idempotencyKey: string,
	signal?: AbortSignal,
): Promise<ClaimAcceptResponse> => {
	// Validate before sending so a malformed endpoint is caught locally, not turned into a
	// server-side state change.
	const body = ClaimAcceptRequestSchema.parse(input)
	return claimRequest(`${tokenPath(token)}/accept`, {
		method: "POST",
		body,
		schema: ClaimAcceptResponseSchema,
		idempotencyKey,
		signal,
	})
}

export const describeClaimError = (error: ClaimApiError): string =>
	error.message
