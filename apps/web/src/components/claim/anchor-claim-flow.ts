import {
	type AnchorIndicativePriceResponse,
	type AnchorWithdrawStatusResponse,
} from "@flexipay/web-lib/claim-contract"

// M1 reference-anchor cash-out state, kept separate from the passkey flow and from ClaimPage.
//
// Two outcomes are deliberately never merged: the claim/payment status comes from the public
// claim view, the anchor withdrawal status comes from the SEP-24 poll. A paid payment, or an
// opened hosted screen, is not a bank payout. Only the anchor's `completed` status is a
// completed cash-out; every other status stays pending or failed.

/** SEP-24 statuses. The contract exposes `status` as a string; only `completed` is success. */
export const SEP24_SUCCESS_STATUS = "completed"
export const SEP24_FAILURE_STATUSES: ReadonlySet<string> = new Set([
	"error",
	"expired",
	"no_market",
	"too_small",
	"too_large",
])

export type AnchorStatusKind = "pending" | "completed" | "failed"

export const anchorStatusKind = (status: string): AnchorStatusKind => {
	if (status === SEP24_SUCCESS_STATUS) return "completed"
	if (SEP24_FAILURE_STATUSES.has(status)) return "failed"
	return "pending"
}

export const ANCHOR_POLL_INTERVAL_MS = 5_000

/**
 * The hosted screen cannot be opened while the API returns only `urlSanitised` (session token
 * stripped, CCR-22). Kept as state so the panel states the blocker instead of offering a dead
 * link; no URL is retained.
 */
export type HostedFlowState = "session_token_stripped" | "invalid"

export type AnchorPhase =
	| "quoting"
	| "quote_ready"
	| "quote_unavailable"
	| "quote_failed"
	| "withdrawing"
	| "awaiting_hosted_flow"
	| "withdraw_failed"
	| "expired"

export interface AnchorWithdrawCarrier {
	/** Stable for the lifetime of this withdraw body; a retry must reuse it. */
	idempotencyKey: string
	body: { amount: string; type?: string }
}

export interface AnchorFlowState {
	phase: AnchorPhase
	/** USDC major units from the claim amount; the contracted 1–10 range. */
	sellAmount: string
	quote: AnchorIndicativePriceResponse | null
	quoteProblem: string | null
	quoteRetryable: boolean
	/** Set on the first withdraw request and never replaced by a retry of the same body. */
	withdraw: AnchorWithdrawCarrier | null
	anchorTxId: string | null
	hostedFlow: HostedFlowState | null
	status: AnchorWithdrawStatusResponse | null
	statusKind: AnchorStatusKind | null
	statusProblem: string | null
	/** Set when the status route rejected the request for a non-retryable reason. */
	statusHalted: boolean
	withdrawProblem: string | null
	withdrawRetryable: boolean
	pollCount: number
}

export type AnchorFlowAction =
	| { type: "quote_loaded"; quote: AnchorIndicativePriceResponse }
	| {
			type: "quote_unavailable"
			problem: string
			retryable: boolean
	  }
	| { type: "quote_requested" }
	| {
			type: "withdraw_requested"
			carrier: AnchorWithdrawCarrier
	  }
	| {
			type: "withdraw_accepted"
			anchorTxId: string
			hostedFlow: HostedFlowState
	  }
	| { type: "withdraw_failed"; problem: string; retryable: boolean }
	| { type: "status_loaded"; status: AnchorWithdrawStatusResponse }
	| { type: "status_failed"; problem: string; retryable: boolean }
	| { type: "expired" }

export const initialAnchorFlow = (sellAmount: string): AnchorFlowState => ({
	phase: "quoting",
	sellAmount,
	quote: null,
	quoteProblem: null,
	quoteRetryable: false,
	withdraw: null,
	anchorTxId: null,
	hostedFlow: null,
	status: null,
	statusKind: null,
	statusProblem: null,
	statusHalted: false,
	withdrawProblem: null,
	withdrawRetryable: false,
	pollCount: 0,
})

/**
 * Only one withdraw body exists per section mount. Re-requesting keeps the original key and body
 * so a retry is the same request; a different body would be a different, unreviewed withdrawal.
 */
const requestWithdraw = (
	state: AnchorFlowState,
	carrier: AnchorWithdrawCarrier,
): AnchorFlowState => {
	const existing = state.withdraw
	if (existing && existing.idempotencyKey !== carrier.idempotencyKey) {
		return state
	}
	if (state.phase === "expired") return state
	return {
		...state,
		phase: "withdrawing",
		withdraw: existing ?? carrier,
		withdrawProblem: null,
		withdrawRetryable: false,
	}
}

/** A withdraw needs a loaded indicative price; the button is not offered before that. */
export const canStartWithdraw = (state: AnchorFlowState): boolean =>
	state.phase === "quote_ready" &&
	state.quote !== null &&
	state.withdraw === null

/** Poll only while an anchor transaction exists and its status is not terminal. */
export const shouldPollAnchor = (state: AnchorFlowState): boolean =>
	Boolean(state.anchorTxId) &&
	!state.statusHalted &&
	state.phase !== "expired" &&
	state.statusKind !== "completed" &&
	state.statusKind !== "failed"

/** Honest outcome label for the anchor leg. `paid` is never used here. */
export const anchorOutcomeLabel = (state: AnchorFlowState): string => {
	if (state.phase === "expired") return "Expired"
	if (!state.anchorTxId) return "Not started"
	if (state.statusKind === "completed") return "Completed"
	if (state.statusKind === "failed") return "Failed"
	if (state.statusKind === "pending") return "Pending"
	return "Awaiting status"
}

export const anchorClaimReducer = (
	state: AnchorFlowState,
	action: AnchorFlowAction,
): AnchorFlowState => {
	switch (action.type) {
		case "quote_requested":
			return {
				...state,
				phase: "quoting",
				quoteProblem: null,
				quoteRetryable: false,
			}
		case "quote_loaded":
			return {
				...state,
				phase: "quote_ready",
				quote: action.quote,
				quoteProblem: null,
				quoteRetryable: false,
			}
		case "quote_unavailable":
			return {
				...state,
				phase: action.retryable ? "quote_failed" : "quote_unavailable",
				quoteProblem: action.problem,
				quoteRetryable: action.retryable,
			}
		case "withdraw_requested":
			return requestWithdraw(state, action.carrier)
		case "withdraw_accepted":
			return {
				...state,
				phase: "awaiting_hosted_flow",
				anchorTxId: action.anchorTxId,
				hostedFlow: action.hostedFlow,
				withdrawProblem: null,
				withdrawRetryable: false,
			}
		case "withdraw_failed":
			return {
				...state,
				phase: state.withdraw ? "withdraw_failed" : "quote_ready",
				withdrawProblem: action.problem,
				withdrawRetryable: action.retryable,
			}
		case "status_loaded":
			return {
				...state,
				status: action.status,
				statusKind: anchorStatusKind(action.status.status),
				statusProblem: null,
				pollCount: state.pollCount + 1,
			}
		case "status_failed":
			return {
				...state,
				statusProblem: action.problem,
				statusHalted: !action.retryable,
				pollCount: state.pollCount + 1,
			}
		case "expired":
			return { ...state, phase: "expired" }
		default:
			return state
	}
}
