import {
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
	type ClaimAcceptRequest,
	type ClaimAcceptResponse,
	type ClaimView,
	type PasskeyDeployRequest,
	type PasskeyDeployResponse,
	type PasskeyPrepareRequest,
	type PasskeyPrepareResponse,
	type PasskeySubmitPendingResponse,
	type PasskeySubmitRequest,
	type PasskeySubmitResponse,
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

export interface ClaimRequestOptions<T> {
	method?: "GET" | "POST"
	body?: unknown
	schema: { parse: (value: unknown) => T }
	idempotencyKey?: string
	signal?: AbortSignal
}

/** Shared by the CCR-22 anchor client: same no-Authorization rule and error shape. */
export async function claimRequest<T>(
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

export const tokenPath = (token: string): string =>
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
 * CCR-21 deploy. Public claim route: no Authorization header is ever attached, the claim token
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

/**
 * CCR-21 prepare. No Idempotency-Key: the response carries secret-bearing auth entries, so it
 * must never be cached as an idempotent response body. The entries stay in memory.
 */
export const preparePasskeyClaim = (
	token: string,
	input: PasskeyPrepareRequest,
	signal?: AbortSignal,
): Promise<PasskeyPrepareResponse> => {
	const body = PasskeyPrepareRequestSchema.parse(input)
	return claimRequest(`${tokenPath(token)}/passkey/prepare`, {
		method: "POST",
		body,
		schema: PasskeyPrepareResponseSchema,
		signal,
	})
}

export type PasskeySubmitOutcome =
	| { status: "settled"; body: PasskeySubmitResponse }
	| { status: "pending"; body: PasskeySubmitPendingResponse }

/** 200 (released) and 202 (pending) are distinct typed outcomes, never a fake success. */
const passkeySubmitResponse = {
	parse(value: unknown): PasskeySubmitOutcome {
		if (isRecord(value) && value.status === "pending")
			return {
				status: "pending",
				body: PasskeySubmitPendingResponseSchema.parse(value),
			}
		return {
			status: "settled",
			body: PasskeySubmitResponseSchema.parse(value),
		}
	},
}

/**
 * CCR-21 submit. Public claim route without a Bearer token. `signedAuthEntries` can contain the
 * claim secret: they are sent once and kept in memory only for the same-key retry.
 */
export const submitPasskeyClaim = (
	token: string,
	input: PasskeySubmitRequest,
	idempotencyKey: string,
	signal?: AbortSignal,
): Promise<PasskeySubmitOutcome> => {
	const body = PasskeySubmitRequestSchema.parse(input)
	return claimRequest(`${tokenPath(token)}/passkey/submit`, {
		method: "POST",
		body,
		schema: passkeySubmitResponse,
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

export type PasskeyRetryStep = "prepare" | "submit"

export interface PasskeyStepFailure {
	message: string
	/** Which step is safe to repeat; null means the flow must stop. */
	retry: PasskeyRetryStep | null
	expired: boolean
}

export const describePasskeyPrepareError = (
	error: ClaimApiError,
): PasskeyStepFailure => {
	if (error.status === 0) {
		return {
			message:
				"The claim API could not be reached, so nothing was signed. Preparing again is safe.",
			retry: "prepare",
			expired: false,
		}
	}
	if (error.status === 404) {
		return {
			message:
				"This claim API does not offer passkey signing yet. The crypto wallet address still works.",
			retry: null,
			expired: false,
		}
	}
	if (error.status === 409 && error.code === "expired") {
		return {
			message: "This claim link has expired. Nothing was signed.",
			retry: null,
			expired: true,
		}
	}
	if (error.status === 409 && error.code === "settle_failed") {
		return {
			message:
				"This payment was returned to the sender, so the claim cannot be released.",
			retry: null,
			expired: false,
		}
	}
	if (error.status === 409) {
		return {
			message:
				"This claim is not waiting for a passkey release. Refresh the claim before trying again.",
			retry: null,
			expired: false,
		}
	}
	if (error.status === 422 && error.code === "contract_mismatch") {
		return {
			message:
				"This claim is bound to a different passkey wallet. Use the wallet that deployed it, or a crypto wallet address.",
			retry: null,
			expired: false,
		}
	}
	if (error.status === 502 || error.status === 503) {
		return {
			message:
				"The claim API could not prepare the claim signature. Nothing was signed; preparing again is safe.",
			retry: "prepare",
			expired: false,
		}
	}
	return {
		message: "The claim signature could not be prepared.",
		retry: null,
		expired: false,
	}
}

export const describePasskeySubmitError = (
	error: ClaimApiError,
): PasskeyStepFailure => {
	if (error.status === 0) {
		return {
			message:
				"The claim API could not be reached. Retrying sends the same signed claim with the same idempotency key.",
			retry: "submit",
			expired: false,
		}
	}
	if (error.status === 409 && error.code === "expired") {
		return {
			message: "This claim link has expired, so the release was not requested.",
			retry: null,
			expired: true,
		}
	}
	if (error.status === 404) {
		return {
			message:
				"The prepared claim was not found by the claim API. Prepare the claim again.",
			retry: "prepare",
			expired: false,
		}
	}
	if (
		error.status === 409 &&
		(error.code === "prepare_expired" ||
			error.code === "auth_expired" ||
			error.code === "idempotency_conflict")
	) {
		return {
			message:
				"The signing window is no longer valid. Prepare the claim again to sign a fresh request.",
			retry: "prepare",
			expired: false,
		}
	}
	if (error.status === 409 && error.code === "settle_failed") {
		return {
			message:
				"This payment was returned to the sender, so the claim cannot be released.",
			retry: null,
			expired: false,
		}
	}
	if (error.status === 409) {
		return {
			message:
				"This claim is no longer waiting for the release. Refresh the claim to see its actual state.",
			retry: null,
			expired: false,
		}
	}
	if (error.status === 422 && error.code === "contract_mismatch") {
		return {
			message:
				"This claim is bound to a different passkey wallet, so the release was not requested.",
			retry: null,
			expired: false,
		}
	}
	if (error.status === 422) {
		return {
			message:
				"The signed claim did not match the prepared request. Prepare the claim again.",
			retry: "prepare",
			expired: false,
		}
	}
	if (error.status === 502 || error.status === 503) {
		return {
			message:
				"The release is not confirmed by the claim API yet. Retrying sends the same signed claim with the same idempotency key.",
			retry: "submit",
			expired: false,
		}
	}
	return {
		message:
			"The claim release could not be confirmed. Refresh the claim to see its actual state.",
		retry: null,
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
