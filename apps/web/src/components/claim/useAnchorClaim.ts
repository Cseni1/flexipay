import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import {
	assessInteractiveUrl,
	describeAnchorPayError,
	describeAnchorQuoteError,
	describeAnchorStatusError,
	describeAnchorWithdrawError,
	getAnchorIndicativePrice,
	getAnchorWithdrawStatus,
	payAnchorWithdraw,
	startAnchorWithdraw,
} from "../../api/anchorClaimClient"
import { ClaimApiError } from "../../api/claimClient"
import {
	ANCHOR_POLL_INTERVAL_MS,
	anchorClaimReducer,
	canRepeatPay,
	canStartPay,
	canStartWithdraw,
	initialAnchorFlow,
	shouldPollAnchor,
	type AnchorWithdrawCarrier,
	type HostedFlowState,
} from "./anchor-claim-flow"

// Owns the M1 anchor cash-out requests for one claim link.
//
// The interactive URL is held only in `hostedUrlRef` (memory, this mount) so the hosted screen can
// be opened and reopened; it is never logged, stored, put in analytics or rendered as text. The
// anchorTxId is likewise memory-only. No effect ever posts /pay: only the click handler does.

const asAnchorError = (cause: unknown): ClaimApiError =>
	cause instanceof ClaimApiError
		? cause
		: new ClaimApiError(0, "unknown_error", "The anchor request failed.")

const isAbort = (cause: unknown): boolean =>
	cause instanceof DOMException && cause.name === "AbortError"

/** Open a placeholder tab in the click handler so the async hosted URL is not popup-blocked. */
const openPlaceholder = (): Window | null => {
	try {
		const popup = window.open("about:blank", "_blank")
		if (popup) popup.opener = null
		return popup
	} catch {
		return null
	}
}

const closePlaceholder = (popup: Window | null): void => {
	try {
		popup?.close()
	} catch {
		// A browser that refuses to close the blank tab only leaves it empty.
	}
}

export interface UseAnchorClaimOptions {
	token: string
	/** USDC major units for the indicative quote only; null skips the quote. */
	quoteAmount: string | null
	claimExpired: boolean
}

export function useAnchorClaim({
	token,
	quoteAmount,
	claimExpired,
}: UseAnchorClaimOptions) {
	const [state, dispatch] = useReducer(
		anchorClaimReducer,
		quoteAmount,
		initialAnchorFlow,
	)
	const withdrawGuard = useRef(false)
	const payGuard = useRef(false)
	const carrier = useRef<AnchorWithdrawCarrier | null>(null)
	const payKey = useRef<string | null>(null)
	const hostedUrlRef = useRef<string | null>(null)
	const pollInFlight = useRef(false)
	const [quoteAttempt, setQuoteAttempt] = useState(0)
	const quoteAbort = useRef<AbortController | null>(null)
	const withdrawAbort = useRef<AbortController | null>(null)

	// Indicative price: read-only, labelled indicative and never a binding rate. Skipped when the
	// claim amount is outside the anchor's 1–10 quote window; the withdraw still uses the API net.
	useEffect(() => {
		if (claimExpired) {
			dispatch({ type: "expired" })
			return
		}
		if (!quoteAmount) return
		const controller = new AbortController()
		quoteAbort.current = controller
		dispatch({ type: "quote_requested" })
		getAnchorIndicativePrice(
			token,
			{ sellAmount: quoteAmount },
			controller.signal,
		)
			.then((quote) => dispatch({ type: "quote_loaded", quote }))
			.catch((cause: unknown) => {
				if (controller.signal.aborted || isAbort(cause)) return
				const failure = describeAnchorQuoteError(asAnchorError(cause))
				dispatch({
					type: "quote_unavailable",
					problem: failure.message,
					retryable: failure.retryable,
				})
				if (failure.expired) dispatch({ type: "expired" })
			})
		return () => controller.abort()
	}, [token, quoteAmount, claimExpired, quoteAttempt])

	// Primitives only: an effect keyed on the whole state would restart on every status object
	// and turn the poll into a tight loop.
	const anchorTxId = state.anchorTxId
	const polling = shouldPollAnchor(state)

	// Anchor status poll: read-only, one interval, stopped on terminal status, navigation,
	// expiry and a halted (non-retryable) status route. Never starts a session or a payment.
	useEffect(() => {
		if (!polling || !anchorTxId) return
		const controller = new AbortController()
		let active = true

		const tick = async () => {
			if (!active || pollInFlight.current) return
			pollInFlight.current = true
			try {
				const status = await getAnchorWithdrawStatus(
					token,
					anchorTxId,
					controller.signal,
				)
				if (active) dispatch({ type: "status_loaded", status })
			} catch (cause) {
				if (!active || isAbort(cause)) return
				const failure = describeAnchorStatusError(asAnchorError(cause))
				dispatch({
					type: "status_failed",
					problem: failure.message,
					retryable: failure.retryable,
				})
				if (failure.expired) dispatch({ type: "expired" })
			} finally {
				pollInFlight.current = false
			}
		}

		void tick()
		const timer = window.setInterval(() => void tick(), ANCHOR_POLL_INTERVAL_MS)
		return () => {
			active = false
			window.clearInterval(timer)
			controller.abort()
		}
	}, [token, anchorTxId, polling])

	useEffect(
		() => () => {
			quoteAbort.current?.abort()
			withdrawAbort.current?.abort()
			// Drop the session URL from memory when leaving the claim. The hosted tab, if the
			// user opened one, stays open; nothing about it is persisted here.
			hostedUrlRef.current = null
		},
		[],
	)

	const submitWithdraw = useCallback(async () => {
		if (withdrawGuard.current) return
		const next: AnchorWithdrawCarrier = carrier.current ?? {
			idempotencyKey: `anchor-withdraw-${crypto.randomUUID()}`,
			// CCR-22: no amount → the backend uses the claim settle net, never the gross amount.
			body: {},
		}
		carrier.current = next
		withdrawGuard.current = true
		const popup = openPlaceholder()
		dispatch({ type: "withdraw_requested", carrier: next })
		const controller = new AbortController()
		withdrawAbort.current = controller
		try {
			const response = await startAnchorWithdraw(
				token,
				next.body,
				next.idempotencyKey,
				controller.signal,
			)
			let hosted: HostedFlowState
			if (response.interactiveUrl) {
				const assessment = assessInteractiveUrl(response.interactiveUrl)
				if (!assessment.openable) {
					hosted = "invalid"
					closePlaceholder(popup)
				} else {
					hostedUrlRef.current = response.interactiveUrl
					if (popup) {
						popup.location.replace(response.interactiveUrl)
						hosted = "opened"
					} else {
						// Popup blocked: the user gets an explicit button for the same URL.
						hosted = "ready"
					}
				}
			} else {
				// Replay/resume: the contract returns no interactiveUrl. Never rebuild one from
				// urlSanitised.
				hosted = "replay_missing"
				closePlaceholder(popup)
			}
			dispatch({
				type: "withdraw_accepted",
				anchorTxId: response.anchorTxId,
				hosted,
			})
		} catch (cause) {
			closePlaceholder(popup)
			if (controller.signal.aborted || isAbort(cause)) return
			const failure = describeAnchorWithdrawError(asAnchorError(cause))
			dispatch({
				type: "withdraw_failed",
				problem: failure.message,
				retryable: failure.retryable,
			})
			if (failure.expired) dispatch({ type: "expired" })
		} finally {
			withdrawGuard.current = false
		}
	}, [token])

	const start = useCallback(() => {
		if (!canStartWithdraw(state)) return
		void submitWithdraw()
	}, [state, submitWithdraw])

	const retry = useCallback(() => {
		if (!state.withdrawRetryable) return
		void submitWithdraw()
	}, [state.withdrawRetryable, submitWithdraw])

	const reloadQuote = useCallback(() => {
		if (!quoteAmount) return
		setQuoteAttempt((value) => value + 1)
	}, [quoteAmount])

	/** User gesture: open (or reopen) the hosted screen from the in-memory URL. */
	const openHosted = useCallback(() => {
		const url = hostedUrlRef.current
		if (!url || !assessInteractiveUrl(url).openable) return
		window.open(url, "_blank", "noopener,noreferrer")
		dispatch({ type: "hosted_opened" })
	}, [])

	const submitPay = useCallback(async () => {
		if (payGuard.current || !anchorTxId) return
		const key = payKey.current ?? `anchor-pay-${crypto.randomUUID()}`
		payKey.current = key
		payGuard.current = true
		dispatch({ type: "pay_requested", key })
		const controller = new AbortController()
		try {
			const outcome = await payAnchorWithdraw(
				token,
				anchorTxId,
				key,
				controller.signal,
			)
			if (outcome.status === "submitted") {
				dispatch({
					type: "pay_submitted",
					hash: outcome.body.anchorPaymentTxHash,
				})
			} else {
				dispatch({ type: "pay_pending", hash: outcome.body.pendingTxHash })
			}
		} catch (cause) {
			if (controller.signal.aborted || isAbort(cause)) return
			const failure = describeAnchorPayError(asAnchorError(cause))
			dispatch({
				type: "pay_failed",
				problem: failure.message,
				retryable: failure.retryable,
			})
			if (failure.expired) dispatch({ type: "expired" })
		} finally {
			payGuard.current = false
		}
	}, [anchorTxId, token])

	/** Explicit click only. A retry reconciles the retained hash; it never creates a new key. */
	const pay = useCallback(() => {
		if (!canStartPay(state) && !canRepeatPay(state)) return
		void submitPay()
	}, [state, submitPay])

	return { state, start, retry, pay, openHosted, reloadQuote }
}
