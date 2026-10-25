import { useCallback, useEffect, useReducer, useRef } from "react"
import {
	assessHostedFlow,
	describeAnchorQuoteError,
	describeAnchorStatusError,
	describeAnchorWithdrawError,
	getAnchorIndicativePrice,
	getAnchorWithdrawStatus,
	startAnchorWithdraw,
} from "../../api/anchorClaimClient"
import { ClaimApiError } from "../../api/claimClient"
import {
	ANCHOR_POLL_INTERVAL_MS,
	anchorClaimReducer,
	canStartWithdraw,
	initialAnchorFlow,
	shouldPollAnchor,
	type AnchorWithdrawCarrier,
} from "./anchor-claim-flow"

// Owns the M1 anchor cash-out requests for one claim link. Nothing here is stored: the anchor
// transaction id lives in memory only, the hosted URL is assessed and dropped immediately, and
// no claim token or anchor payload goes to console, storage, analytics or evidence snapshots.

const asAnchorError = (cause: unknown): ClaimApiError =>
	cause instanceof ClaimApiError
		? cause
		: new ClaimApiError(0, "unknown_error", "The anchor request failed.")

const isAbort = (cause: unknown): boolean =>
	cause instanceof DOMException && cause.name === "AbortError"

export interface UseAnchorClaimOptions {
	token: string
	/** USDC major units derived from the claim amount (already range-checked). */
	sellAmount: string
	claimExpired: boolean
}

export function useAnchorClaim({
	token,
	sellAmount,
	claimExpired,
}: UseAnchorClaimOptions) {
	const [state, dispatch] = useReducer(
		anchorClaimReducer,
		sellAmount,
		initialAnchorFlow,
	)
	const withdrawGuard = useRef(false)
	const carrier = useRef<AnchorWithdrawCarrier | null>(null)
	const pollInFlight = useRef(false)
	const quoteAbort = useRef<AbortController | null>(null)
	const withdrawAbort = useRef<AbortController | null>(null)

	// Indicative price: read-only, labelled indicative, and never a binding rate. The claim API
	// returns it for an open claim even before the vault release.
	useEffect(() => {
		if (claimExpired) {
			dispatch({ type: "expired" })
			return
		}
		const controller = new AbortController()
		quoteAbort.current = controller
		dispatch({ type: "quote_requested" })
		getAnchorIndicativePrice(token, { sellAmount }, controller.signal)
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
	}, [token, sellAmount, claimExpired])

	// Primitives only: an effect keyed on the whole state would restart on every status object
	// and turn the poll into a tight loop.
	const anchorTxId = state.anchorTxId
	const polling = shouldPollAnchor(state)

	// Anchor status poll. One interval per known anchorTxId, no parallel ticks, stopped on
	// terminal status, on navigation (cleanup) and when the claim expires.
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
		},
		[],
	)

	const submitWithdraw = useCallback(async () => {
		if (withdrawGuard.current) return
		const next: AnchorWithdrawCarrier = carrier.current ?? {
			idempotencyKey: `anchor-withdraw-${crypto.randomUUID()}`,
			body: { amount: sellAmount },
		}
		carrier.current = next
		withdrawGuard.current = true
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
			// The API's URL is sanitised on purpose. Assess and drop it: nothing about the hosted
			// session is kept, and no link is offered that could not resume the session anyway.
			const hosted = assessHostedFlow(response.urlSanitised)
			dispatch({
				type: "withdraw_accepted",
				anchorTxId: response.anchorTxId,
				hostedFlow:
					hosted.problem === "not_absolute"
						? "invalid"
						: "session_token_stripped",
			})
		} catch (cause) {
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
	}, [sellAmount, token])

	const start = useCallback(() => {
		if (!canStartWithdraw(state)) return
		void submitWithdraw()
	}, [state, submitWithdraw])

	const retry = useCallback(() => {
		if (!state.withdrawRetryable) return
		void submitWithdraw()
	}, [state.withdrawRetryable, submitWithdraw])

	return { state, start, retry }
}
