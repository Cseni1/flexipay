import {
	AnchorIndicativePriceRequestSchema,
	AnchorIndicativePriceResponseSchema,
	AnchorPayPendingResponseSchema,
	AnchorPayRequestSchema,
	AnchorPayResponseSchema,
	AnchorWithdrawRequestSchema,
	AnchorWithdrawResponseSchema,
	AnchorWithdrawStatusResponseSchema,
	type AnchorIndicativePriceRequest,
	type AnchorIndicativePriceResponse,
	type AnchorPayPendingResponse,
	type AnchorPayResponse,
	type AnchorWithdrawRequest,
	type AnchorWithdrawResponse,
	type AnchorWithdrawStatusResponse,
} from "@flexipay/web-lib/claim-contract"
import { claimRequest, tokenPath, type ClaimApiError } from "./claimClient"

// CCR-22 public claim-link anchor routes. Same rules as the other claim calls: no Authorization
// header ever and the claim token stays in the request path.
//
// A paid payment, an opened hosted screen, a submitted classic payment or a terminal SEP-24
// status is not a bank payout by itself: only the anchor's successful status is an outcome.
// The interactive URL is used from memory once; it is never logged, persisted, sent to
// analytics or put in evidence.

export const getAnchorIndicativePrice = (
	token: string,
	input: AnchorIndicativePriceRequest,
	signal?: AbortSignal,
): Promise<AnchorIndicativePriceResponse> => {
	const body = AnchorIndicativePriceRequestSchema.parse(input)
	return claimRequest(`${tokenPath(token)}/anchor/indicative-price`, {
		method: "POST",
		body,
		schema: AnchorIndicativePriceResponseSchema,
		signal,
	})
}

/**
 * Starts the SEP-24 withdrawal that backs the reference-anchor cash-out. `Idempotency-Key` is
 * required: a network retry of the same request must reuse the same key and the same body.
 *
 * CCR-22 makes `amount` optional and defaults it to the claim settle net; this app omits it on
 * purpose and never substitutes the gross claim amount. `type` is omitted too (the contract
 * allows only `bank_account` or omitted; the anchor's hosted screen asks for the details).
 */
export const startAnchorWithdraw = (
	token: string,
	input: AnchorWithdrawRequest,
	idempotencyKey: string,
	signal?: AbortSignal,
): Promise<AnchorWithdrawResponse> => {
	const body = AnchorWithdrawRequestSchema.parse(input)
	return claimRequest(`${tokenPath(token)}/anchor/withdraw`, {
		method: "POST",
		body,
		schema: AnchorWithdrawResponseSchema,
		idempotencyKey,
		signal,
	})
}

export const getAnchorWithdrawStatus = (
	token: string,
	anchorTxId: string,
	signal?: AbortSignal,
): Promise<AnchorWithdrawStatusResponse> =>
	claimRequest(
		`${tokenPath(token)}/anchor/withdraw/${encodeURIComponent(anchorTxId)}`,
		{ schema: AnchorWithdrawStatusResponseSchema, signal },
	)

export type AnchorPayOutcome =
	| { status: "submitted"; body: AnchorPayResponse }
	| { status: "pending"; body: AnchorPayPendingResponse }

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null

/** 200 (submitted) and 202 (pending) are distinct outcomes; neither is a completed cash-out. */
const anchorPayResponse = {
	parse(value: unknown): AnchorPayOutcome {
		if (isRecord(value) && value.status === "pending") {
			return {
				status: "pending",
				body: AnchorPayPendingResponseSchema.parse(value),
			}
		}
		return {
			status: "submitted",
			body: AnchorPayResponseSchema.parse(value),
		}
	},
}

/**
 * Explicit user action: submit the classic memo payment to the anchor.
 *
 * Only ever called from a click handler. GET/status polling, rendering and returning from the
 * hosted screen never call this. The public replay is reconcile-only, so a retry with the same
 * key cannot send a second transaction; a new key is never generated to bypass a definitive 409.
 */
export const payAnchorWithdraw = (
	token: string,
	anchorTxId: string,
	idempotencyKey: string,
	signal?: AbortSignal,
): Promise<AnchorPayOutcome> => {
	const body = AnchorPayRequestSchema.parse({})
	return claimRequest(
		`${tokenPath(token)}/anchor/withdraw/${encodeURIComponent(anchorTxId)}/pay`,
		{
			method: "POST",
			body,
			schema: anchorPayResponse,
			idempotencyKey,
			signal,
		},
	)
}

export type InteractiveUrlProblem = "not_absolute" | "unsafe"

export interface InteractiveUrlAssessment {
	openable: boolean
	problem: InteractiveUrlProblem | null
}

/**
 * The first withdraw response may include the full interactive URL, with the SEP-24 session
 * token. It is the only value that can actually open the anchor's hosted screen; the replay's
 * `urlSanitised` must never be turned into a link. Only an absolute http(s) URL without
 * credentials is opened, and the URL itself is kept in memory by the caller.
 */
export const assessInteractiveUrl = (url: string): InteractiveUrlAssessment => {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return { openable: false, problem: "not_absolute" }
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return { openable: false, problem: "unsafe" }
	}
	if (parsed.username || parsed.password) {
		return { openable: false, problem: "unsafe" }
	}
	return { openable: true, problem: null }
}

/** Stable, payload-free copy for the three anchor routes. */
export interface AnchorStepFailure {
	message: string
	retryable: boolean
	expired: boolean
}

export const describeAnchorQuoteError = (
	error: ClaimApiError,
): AnchorStepFailure => {
	if (error.status === 0) {
		return {
			message:
				"The claim API could not be reached, so no indicative price was shown.",
			retryable: true,
			expired: false,
		}
	}
	if (error.status === 404) {
		return {
			message:
				"This claim API does not offer the reference-anchor cash-out yet. No anchor request was made.",
			retryable: false,
			expired: false,
		}
	}
	if (error.status === 409 && error.code === "expired") {
		return {
			message: "This claim link has expired. No anchor request was made.",
			retryable: false,
			expired: true,
		}
	}
	if (error.status === 409 && error.code === "settle_failed") {
		return {
			message:
				"The funds for this payment were returned to the sender, so the anchor cash-out is refused.",
			retryable: false,
			expired: false,
		}
	}
	if (error.status === 409) {
		return {
			message:
				"This claim is not in a state where the reference anchor can quote it.",
			retryable: false,
			expired: false,
		}
	}
	if (error.status === 422) {
		return {
			message: `The reference anchor rejected the indicative price request (${error.code}). No anchor request was made.`,
			retryable: false,
			expired: false,
		}
	}
	if (error.status === 502 || error.status === 503) {
		return {
			message:
				"The reference anchor (or the claim API's anchor credentials) is unavailable right now. No anchor request was made.",
			retryable: true,
			expired: false,
		}
	}
	return {
		message: "The indicative price could not be loaded.",
		retryable: false,
		expired: false,
	}
}

export const describeAnchorWithdrawError = (
	error: ClaimApiError,
): AnchorStepFailure => {
	if (error.status === 0) {
		return {
			message:
				"The claim API could not be reached. Retrying sends the same anchor request with the same idempotency key.",
			retryable: true,
			expired: false,
		}
	}
	if (error.status === 404) {
		return {
			message:
				"This claim API does not offer the reference-anchor cash-out yet. Nothing was started.",
			retryable: false,
			expired: false,
		}
	}
	if (error.status === 409 && error.code === "expired") {
		return {
			message:
				"This claim link has expired, so no anchor withdrawal was started.",
			retryable: false,
			expired: true,
		}
	}
	if (error.status === 409 && error.code === "settle_failed") {
		return {
			message:
				"The funds for this payment were returned to the sender, so no anchor withdrawal was started.",
			retryable: false,
			expired: false,
		}
	}
	if (error.status === 409 && error.code === "idempotency_conflict") {
		return {
			message:
				"The idempotency key of this anchor request no longer matches the claim. Reload the claim before trying again.",
			retryable: false,
			expired: false,
		}
	}
	if (error.status === 409) {
		return {
			message:
				"The claim API refused the anchor withdrawal in this state. The vault release to a classic G… wallet must come first.",
			retryable: false,
			expired: false,
		}
	}
	if (error.status === 422 && error.code === "amount_out_of_range") {
		return {
			message:
				"The reference anchor accepts 1 to 10 USDC per testnet withdrawal, so this amount was refused.",
			retryable: false,
			expired: false,
		}
	}
	if (error.status === 422 && error.code === "anchor_asset_mismatch") {
		return {
			message:
				"This payment settles in a different asset than the reference anchor's USDC, so the withdrawal was refused.",
			retryable: false,
			expired: false,
		}
	}
	if (error.status === 422) {
		return {
			message: `The reference anchor refused the withdrawal request (${error.code}). Nothing was started.`,
			retryable: false,
			expired: false,
		}
	}
	if (error.status === 502 || error.status === 503) {
		return {
			message:
				"The reference anchor could not be reached. Retrying sends the same anchor request with the same idempotency key, so no second withdrawal is started.",
			retryable: true,
			expired: false,
		}
	}
	return {
		message: "The anchor withdrawal could not be started.",
		retryable: false,
		expired: false,
	}
}

/**
 * /pay failures. A definitive 409 is shown as-is and never retried with a new key; a network
 * or 502 failure is safe to repeat with the same key because the public replay only reconciles
 * the retained hash instead of sending another transaction.
 */
export const describeAnchorPayError = (
	error: ClaimApiError,
): AnchorStepFailure => {
	if (error.status === 0) {
		return {
			message:
				"The claim API could not be reached. Retrying reuses the same idempotency key, so the retained payment is only reconciled, never resent.",
			retryable: true,
			expired: false,
		}
	}
	if (error.status === 404) {
		return {
			message:
				"The claim API does not know this anchor transaction for this claim. No payment was confirmed.",
			retryable: false,
			expired: false,
		}
	}
	if (error.status === 409) {
		if (error.code === "expired") {
			return {
				message:
					"This claim link has expired. No anchor payment was submitted.",
				retryable: false,
				expired: true,
			}
		}
		// Definitive: the backend refused this payment (wrong SEP-24 state, on-chain
		// rejection, settle failure, idempotency conflict). Do not try another key.
		return {
			message:
				error.message.trim() ||
				"The claim API refused the anchor payment in its current state. Do not retry; reconcile the anchor status instead.",
			retryable: false,
			expired: false,
		}
	}
	if (error.status === 422) {
		return {
			message: `The claim API refused the anchor payment (${error.code}). Nothing may be resent.`,
			retryable: false,
			expired: false,
		}
	}
	if (error.status === 502 || error.status === 503) {
		return {
			message:
				"The anchor payment outcome is uncertain. Retrying the same request only reconciles the retained transaction hash; it never sends a second payment.",
			retryable: true,
			expired: false,
		}
	}
	return {
		message:
			"The anchor payment could not be confirmed. Check the anchor status; no new payment is started.",
		retryable: false,
		expired: false,
	}
}

export const describeAnchorStatusError = (
	error: ClaimApiError,
): AnchorStepFailure => {
	if (error.status === 0) {
		return {
			message:
				"The anchor status could not be refreshed. The last known status stays on screen.",
			retryable: true,
			expired: false,
		}
	}
	if (error.status === 404) {
		return {
			message:
				"The claim API does not know this anchor transaction for this claim. It may belong to another claim; nothing here is completed.",
			retryable: false,
			expired: false,
		}
	}
	if (error.status === 409 && error.code === "expired") {
		return {
			message:
				"This claim link has expired. The anchor status is no longer polled.",
			retryable: false,
			expired: true,
		}
	}
	if (error.status === 502 || error.status === 503) {
		return {
			message:
				"The reference anchor is unavailable right now. The last known status stays on screen.",
			retryable: true,
			expired: false,
		}
	}
	return {
		message: "The anchor status could not be refreshed.",
		retryable: false,
		expired: false,
	}
}
