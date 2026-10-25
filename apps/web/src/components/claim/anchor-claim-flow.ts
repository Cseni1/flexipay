import {
	type AnchorWithdrawRequest,
	type AnchorWithdrawStatusResponse,
	type AnchorIndicativePriceResponse,
} from "@flexipay/web-lib/claim-contract"

// M1 reference-anchor cash-out state, kept separate from the passkey flow and from ClaimPage.
//
// Four records stay separate and are never conflated:
//   - vault release           (Leg.releaseTxRef, shown from the status response)
//   - our classic payment     (anchorPaymentTxHash)
//   - the anchor's own tx     (anchorStellarTransactionId)
//   - the SEP-24 transaction  (anchorTxId)
//
// Only the anchor's `completed` status with `terminal: true` is a completed cash-out. `terminal`
// on its own is not success, and a submitted/paid payment is not a bank payout.

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

/** The hosted screen link is returned once; the replay has none and none may be invented. */
export type HostedFlowState = "ready" | "opened" | "replay_missing" | "invalid"

export type AnchorPhase =
	| "quoting"
	| "quote_ready"
	| "quote_skipped"
	| "quote_unavailable"
	| "quote_failed"
	| "withdrawing"
	| "awaiting_hosted_flow"
	| "withdraw_failed"
	| "expired"

export interface AnchorWithdrawCarrier {
	/** Stable for the lifetime of this withdraw body; a retry must reuse it. */
	idempotencyKey: string
	/** CCR-22: `{}` lets the backend use the claim settle net; the gross amount is not sent. */
	body: AnchorWithdrawRequest
}

export type AnchorPayPhase =
	"idle" | "submitting" | "submitted" | "pending" | "failed"

export interface AnchorFlowState {
	phase: AnchorPhase
	/** USDC major units for the indicative quote; null when the claim amount is outside 1–10. */
	quoteAmount: string | null
	quote: AnchorIndicativePriceResponse | null
	quoteProblem: string | null
	quoteRetryable: boolean
	withdraw: AnchorWithdrawCarrier | null
	anchorTxId: string | null
	hosted: HostedFlowState | null
	status: AnchorWithdrawStatusResponse | null
	statusKind: AnchorStatusKind | null
	statusProblem: string | null
	/** Set when the status route rejected the request for a non-retryable reason. */
	statusHalted: boolean
	withdrawProblem: string | null
	withdrawRetryable: boolean
	pollCount: number
	/** Created on the first /pay click for this anchor transaction and never replaced. */
	payKey: string | null
	pay: AnchorPayPhase
	payProblem: string | null
	payRetryable: boolean
	/** 200 submitted hash (our classic memo payment). */
	submittedHash: string | null
	/** 202 retained hash; reconcile-only, never resent. */
	pendingHash: string | null
}

export type AnchorFlowAction =
	| { type: "quote_requested" }
	| { type: "quote_loaded"; quote: AnchorIndicativePriceResponse }
	| { type: "quote_unavailable"; problem: string; retryable: boolean }
	| { type: "withdraw_requested"; carrier: AnchorWithdrawCarrier }
	| {
			type: "withdraw_accepted"
			anchorTxId: string
			hosted: HostedFlowState
	  }
	| { type: "withdraw_failed"; problem: string; retryable: boolean }
	| { type: "hosted_opened" }
	| { type: "status_loaded"; status: AnchorWithdrawStatusResponse }
	| { type: "status_failed"; problem: string; retryable: boolean }
	| { type: "pay_requested"; key: string }
	| { type: "pay_submitted"; hash: string }
	| { type: "pay_pending"; hash: string }
	| { type: "pay_failed"; problem: string; retryable: boolean }
	| { type: "expired" }

export const initialAnchorFlow = (
	quoteAmount: string | null,
): AnchorFlowState => ({
	phase: quoteAmount ? "quoting" : "quote_skipped",
	quoteAmount,
	quote: null,
	quoteProblem: null,
	quoteRetryable: false,
	withdraw: null,
	anchorTxId: null,
	hosted: null,
	status: null,
	statusKind: null,
	statusProblem: null,
	statusHalted: false,
	withdrawProblem: null,
	withdrawRetryable: false,
	pollCount: 0,
	payKey: null,
	pay: "idle",
	payProblem: null,
	payRetryable: false,
	submittedHash: null,
	pendingHash: null,
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

/** The withdraw only needs the quote attempt to be finished; it never sends an amount. */
export const canStartWithdraw = (state: AnchorFlowState): boolean =>
	(state.phase === "quote_ready" || state.phase === "quote_skipped") &&
	state.withdraw === null

/** Explicit click only: the anchor must be asking for the transfer and no pay exists yet. */
export const canStartPay = (state: AnchorFlowState): boolean =>
	Boolean(state.anchorTxId) &&
	state.phase !== "expired" &&
	state.pay === "idle" &&
	state.status?.status === "pending_user_transfer_start"

/** A retry/reconciliation is allowed only when it cannot create a second payment. */
export const canRepeatPay = (state: AnchorFlowState): boolean =>
	state.phase !== "expired" &&
	(state.pay === "pending" || (state.pay === "failed" && state.payRetryable))

/** Poll while the anchor transaction exists, is not terminal and the route has not halted. */
export const shouldPollAnchor = (state: AnchorFlowState): boolean =>
	Boolean(state.anchorTxId) &&
	!state.statusHalted &&
	state.phase !== "expired" &&
	state.status?.terminal !== true

/** Completed only from the anchor's successful terminal status. */
export const anchorCompleted = (state: AnchorFlowState): boolean =>
	state.status?.status === SEP24_SUCCESS_STATUS &&
	state.status.terminal === true

/** Honest outcome label for the anchor leg. `paid` and `submitted` are never used here. */
export const anchorOutcomeLabel = (state: AnchorFlowState): string => {
	if (state.phase === "expired") return "Expired"
	if (!state.anchorTxId) return "Not started"
	if (anchorCompleted(state)) return "Completed"
	if (state.statusKind === "failed") return "Failed"
	if (state.status?.terminal) return "Terminal, not completed"
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
				hosted: action.hosted,
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
		case "hosted_opened":
			return { ...state, hosted: "opened" }
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
		case "pay_requested":
			return {
				...state,
				payKey: state.payKey ?? action.key,
				pay: "submitting",
				payProblem: null,
				payRetryable: false,
			}
		case "pay_submitted":
			return {
				...state,
				pay: "submitted",
				payProblem: null,
				payRetryable: false,
				submittedHash: action.hash,
			}
		case "pay_pending":
			return {
				...state,
				pay: "pending",
				payProblem: null,
				payRetryable: true,
				pendingHash: action.hash,
			}
		case "pay_failed":
			return {
				...state,
				pay: "failed",
				payProblem: action.problem,
				payRetryable: action.retryable,
			}
		case "expired":
			return { ...state, phase: "expired" }
		default:
			return state
	}
}
