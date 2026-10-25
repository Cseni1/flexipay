import {
	ClaimAcceptRequestSchema,
	ClaimAcceptResponseSchema,
	ClaimViewSchema,
	PasskeyDeployRequestSchema,
	PasskeyDeployResponseSchema,
	type ClaimAcceptRequest,
	type ClaimAcceptResponse,
	type ClaimView,
	type PasskeyDeployRequest,
	type PasskeyDeployResponse,
} from "@flexipay/web-lib/claim-contract"

// Public claim routes are same-origin and use their own client: no Authorization header is
// ever set here, and the Vite proxy forwards claims upstream without one. The raw claim token
// comes from the URL and is used only in the request path: it is never logged, stored in
// browser storage or sent elsewhere.

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

/**
 * CCR-20 deploy. Public claim route: no Authorization header is ever attached, the claim token
 * stays in the path, and `signedTx` is the passkey-kit carrier (standard base64 XDR), never
 * logged or stored. The same Idempotency-Key must be reused for a retry of the same carrier.
 */
export const deployPasskeyWallet = (
	token: string,
	input: PasskeyDeployRequest,
	idempotencyKey: string,
	signal?: AbortSignal,
): Promise<PasskeyDeployResponse> => {
	const body = PasskeyDeployRequestSchema.parse(input)
	return claimRequest(`${tokenPath(token)}/passkey/deploy`, {
		method: "POST",
		body,
		schema: PasskeyDeployResponseSchema,
		idempotencyKey,
		signal,
	})
}

export interface PasskeyDeployFailure {
	message: string
	retryable: boolean
	expired: boolean
}

/** Stable, payload-free copy for the deploy route; the web app never surfaces raw API internals. */
export const describePasskeyDeployError = (
	error: ClaimApiError,
): PasskeyDeployFailure => {
	if (error.status === 0) {
		return {
			message:
				"The claim API could not be reached. Retrying sends the same deploy request with the same idempotency key.",
			retryable: true,
			expired: false,
		}
	}
	if (error.status === 404) {
		return {
			message:
				"This claim API does not offer passkey wallets yet. No wallet was deployed; a crypto wallet address still works.",
			retryable: false,
			expired: false,
		}
	}
	if (error.status === 409 && error.code === "expired") {
		return {
			message:
				"This claim link has expired. No wallet was deployed by this page.",
			retryable: false,
			expired: true,
		}
	}
	if (error.status === 409) {
		return {
			message:
				"This claim is no longer open for a passkey wallet. Refresh the claim before trying again.",
			retryable: false,
			expired: false,
		}
	}
	if (error.status === 422) {
		return {
			message: `The claim API rejected the wallet deploy transaction (${error.code}).`,
			retryable: false,
			expired: false,
		}
	}
	if (error.status === 502 || error.status === 503) {
		return {
			message:
				"The claim API could not deploy the wallet. Retrying sends the same deploy request with the same idempotency key, so no second wallet is created.",
			retryable: true,
			expired: false,
		}
	}
	return {
		message:
			"The passkey wallet could not be deployed. No wallet was confirmed by the claim API.",
		retryable: false,
		expired: false,
	}
}

export const describeClaimError = (error: ClaimApiError): string => {
	// Prefer the API message so 409 invalid_state / state_conflict are never shown as success.
	if (error.message.trim()) return error.message
	if (error.status === 409) {
		return "This claim cannot be accepted in its current state. Refresh the claim first."
	}
	return claimMessage(error.status)
}
