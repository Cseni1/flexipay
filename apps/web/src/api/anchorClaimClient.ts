import {
	AnchorIndicativePriceRequestSchema,
	AnchorIndicativePriceResponseSchema,
	AnchorWithdrawRequestSchema,
	AnchorWithdrawResponseSchema,
	AnchorWithdrawStatusResponseSchema,
	type AnchorIndicativePriceRequest,
	type AnchorIndicativePriceResponse,
	type AnchorWithdrawRequest,
	type AnchorWithdrawResponse,
	type AnchorWithdrawStatusResponse,
} from "@flexipay/web-lib/claim-contract"
import { claimRequest, tokenPath, type ClaimApiError } from "./claimClient"

// CCR-22 public claim-link anchor routes. Same rules as the other claim calls: no Authorization
// header ever, the claim token stays in the request path, and the hosted interactive URL (with
// its SEP-24 session token) never reaches this module: the API returns a sanitised URL only.
//
// A payment that is paid, or a hosted URL that was opened, is not a bank payout. The anchor
// status is the only source of an anchor outcome.

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

/** The API's hosted URL is sanitised: safe to show in evidence, not enough to resume a session. */
export type HostedFlowProblem = "session_token_stripped" | "not_absolute"

export interface HostedFlowAssessment {
	openable: boolean
	problem: HostedFlowProblem | null
	/** Origin + path only, or null when the value is not an absolute http(s) URL. */
	display: string | null
}

/**
 * CCR-22 defines `urlSanitised` as the hosted URL with the query/token stripped, precisely so
 * the session material never reaches a browser log or evidence file. A SEP-24 interactive
 * session needs that token, so this value cannot open the hosted screen, and the page must not
 * invent one. The value is assessed here and never stored: only the boolean result is kept.
 */
export const assessHostedFlow = (
	urlSanitised: string,
): HostedFlowAssessment => {
	let url: URL
	try {
		url = new URL(urlSanitised)
	} catch {
		return { openable: false, problem: "not_absolute", display: null }
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { openable: false, problem: "not_absolute", display: null }
	}
	if (url.username || url.password) {
		return { openable: false, problem: "not_absolute", display: null }
	}
	return {
		openable: false,
		problem: "session_token_stripped",
		display: `${url.origin}${url.pathname}`,
	}
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
