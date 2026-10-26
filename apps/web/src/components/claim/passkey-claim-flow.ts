// Passkey claim UI state for the M2 milestone (CCR-21).
//
// The reducer is pure UI state: it holds no auth entries, signed entries, XDR, claim secret or
// claim token. Those live only in the controller's in-memory refs, never in React state or logs.
// After a confirmed deploy, passkeyWallet may keep ONLY public wallet facts in a tab-scoped
// browser store (contractId, keyIdBase64, publicKey, deployTxHash) so reload can resume Bind —
// never signedTx, auth entries, claim secret or the raw claim token. The full chain is:
//
//   wallet create (register → Confirm with passkey) → deploy → Bind wallet → prepare → sign → submit
//   (or reload → wallet_resumed → Bind wallet → …)
//
// Create-time Confirm and post-deploy Bind are separate user gestures. Binding never auto-starts
// after create/deploy/resume. The post-registration startAuthentication is gated behind Confirm so
// it runs from that click, continuing the same createWallet (no second registration).
// Submit semantics: 200 + releaseTxRef is a confirmed release (paid only when the API says so);
// 202 is pending and never paid. A network retry reuses the same submit body and idempotency key;
// a new prepare gets a new key.

export type PasskeyClaimPhase =
	/** Public passkey config absent: no RPC/passphrase in this build. */
	| "unavailable"
	/** The browser has no WebAuthn support. */
	| "unsupported"
	| "idle"
	| "creating_wallet"
	/** Registration done; waiting for Confirm with passkey (same createWallet). */
	| "awaiting_creation_confirm"
	| "deploying"
	/** Deploy confirmed; waiting for an explicit Bind wallet click. */
	| "deployed"
	| "deploy_failed"
	| "binding"
	| "binding_failed"
	/** Credential bound; claim prepare/sign may proceed. */
	| "bound"
	| "preparing"
	| "awaiting_signature"
	| "signing"
	| "submitting"
	/** 202: release persisted/submitted but not yet confirmed; never paid. */
	| "processing"
	/** 200 + releaseTxRef, but the API has not reported a paid payment. */
	| "released"
	/** 200 + accepted claim + paid payment, confirmed by the API. */
	| "verified"
	| "unconfirmed"
	| "cancelled"
	| "expired"
	| "retryable_error"

/** Which step a retry would repeat. `create` needs a fresh passkey; `bind` reuses the credential. */
export type PasskeyRetryTarget =
	"create" | "deploy" | "bind" | "prepare" | "submit"

export interface PasskeyVerifiedClaim {
	claimStatus: "accepted"
	paymentStatus: string
}

/** Non-sensitive Bind failure facts (mirrors passkeyWallet.PasskeyBindDiagnostic). */
export interface PasskeyBindDiagnosticState {
	step: "confirmWalletCreation" | "connectWallet"
	errorName: string
	errorCode: string | number | null
	reason: string | null
	contractId: string
}

export interface PasskeyClaimFlowState {
	phase: PasskeyClaimPhase
	contractId: string | null
	/** Ledger-confirmed deploy hash returned by the API; never a fabricated one. */
	deployTxHash: string | null
	prepareId: string | null
	/** The sole ledger the API accepts for this prepare's signatures. */
	signatureExpirationLedger: number | null
	/** Number of prepared auth entries; the entries themselves stay out of React state. */
	authEntryCount: number | null
	deployIdempotencyKey: string | null
	submitIdempotencyKey: string | null
	/** Settle leg releaseTxRef; only from a 200 submit response. */
	releaseTxRef: string | null
	/** 202 pendingTxHash; not a success reference. */
	pendingTxHash: string | null
	apiPaymentStatus: string | null
	retry: PasskeyRetryTarget | null
	message: string | null
	/** Short Bind kit diagnostic; never XDR/keys/tokens. */
	bindDiagnostic: PasskeyBindDiagnosticState | null
	verified: PasskeyVerifiedClaim | null
}

export type PasskeyClaimEvent =
	| { type: "wallet_creation_started" }
	| { type: "creation_confirm_needed" }
	| { type: "creation_confirm_started" }
	| { type: "creation_confirm_dismissed"; message: string }
	| { type: "creation_confirm_failed"; message: string }
	| {
			type: "wallet_created"
			contractId: string
			deployIdempotencyKey: string
	  }
	| { type: "wallet_creation_failed"; message: string }
	| { type: "deploy_succeeded"; deployTxHash: string }
	| { type: "deploy_failed"; message: string; retryable?: boolean }
	/** Reload restored public deploy facts; Bind stays an explicit click. */
	| {
			type: "wallet_resumed"
			contractId: string
			deployTxHash: string
	  }
	| { type: "bind_started" }
	| { type: "bind_succeeded" }
	| {
			type: "bind_failed"
			message: string
			diagnostic?: PasskeyBindDiagnosticState | null
	  }
	| { type: "bind_cancelled"; message: string }
	| { type: "prepare_started" }
	| {
			type: "prepared"
			prepareId: string
			signatureExpirationLedger: number
			authEntryCount: number
	  }
	| { type: "prepare_failed"; message: string; retryable?: boolean }
	| { type: "signing_started" }
	| { type: "signature_dismissed"; message: string }
	| { type: "signing_failed"; message: string }
	| { type: "signed"; submitIdempotencyKey: string }
	| {
			type: "submit_pending"
			pendingTxHash: string
			paymentStatus: string
	  }
	| {
			type: "submit_settled"
			claimStatus: string
			paymentStatus: string
			releaseTxRef: string
	  }
	| {
			type: "submit_rejected"
			message: string
			retry: PasskeyRetryTarget | null
	  }
	/** 202 follow-up: same signed body and same Idempotency-Key, never a new submit. */
	| { type: "submit_retry" }
	| { type: "retry" }
	| { type: "cancelled" }
	| { type: "expired" }

const BUSY_PHASES = new Set<PasskeyClaimPhase>([
	"creating_wallet",
	"awaiting_creation_confirm",
	"deploying",
	"binding",
	"preparing",
	"signing",
	"submitting",
	"processing",
])

const TERMINAL_PHASES = new Set<PasskeyClaimPhase>([
	"unavailable",
	"unsupported",
	"verified",
	"released",
	"cancelled",
	"expired",
])

export const isPasskeySupported = (): boolean =>
	typeof window !== "undefined" &&
	typeof window.PublicKeyCredential === "function"

export const initialPasskeyFlow = ({
	deployAvailable,
	supported,
}: {
	deployAvailable: boolean
	supported: boolean
}): PasskeyClaimFlowState => ({
	phase: !deployAvailable ? "unavailable" : supported ? "idle" : "unsupported",
	contractId: null,
	deployTxHash: null,
	prepareId: null,
	signatureExpirationLedger: null,
	authEntryCount: null,
	deployIdempotencyKey: null,
	submitIdempotencyKey: null,
	releaseTxRef: null,
	pendingTxHash: null,
	apiPaymentStatus: null,
	retry: null,
	message: null,
	bindDiagnostic: null,
	verified: null,
})

const unchanged = (state: PasskeyClaimFlowState): PasskeyClaimFlowState => state

export const isPasskeyBusy = (phase: PasskeyClaimPhase): boolean =>
	BUSY_PHASES.has(phase)

export const isPasskeyTerminal = (phase: PasskeyClaimPhase): boolean =>
	TERMINAL_PHASES.has(phase)

export const canCreatePasskeyWallet = (flow: PasskeyClaimFlowState): boolean =>
	flow.phase === "idle"

/** Confirm with passkey during the same createWallet (post-registration auth). */
export const canConfirmPasskeyCreation = (
	flow: PasskeyClaimFlowState,
): boolean => flow.phase === "awaiting_creation_confirm"

/** Explicit Bind wallet click only; never starts from create/deploy completion. */
export const canBindPasskeyWallet = (flow: PasskeyClaimFlowState): boolean =>
	(flow.phase === "deployed" || flow.phase === "binding_failed") &&
	Boolean(flow.contractId && flow.deployTxHash)

export const canPreparePasskeyClaim = (flow: PasskeyClaimFlowState): boolean =>
	flow.phase === "bound"

/** Approval is refused once the claim is no longer open at `expiresAt`. */
export const canApprovePasskeyClaim = (
	flow: PasskeyClaimFlowState,
	claimExpired: boolean,
): boolean =>
	(flow.phase === "awaiting_signature" || flow.phase === "signing") &&
	!claimExpired

/** A 202 may be re-checked by re-sending the same signed request and idempotency key. */
export const canCheckPasskeyRelease = (flow: PasskeyClaimFlowState): boolean =>
	flow.phase === "processing" &&
	flow.prepareId !== null &&
	flow.submitIdempotencyKey !== null

export const canRetryPasskeyStep = (
	flow: PasskeyClaimFlowState,
	claimExpired: boolean,
): boolean =>
	!claimExpired &&
	flow.retry !== null &&
	(flow.phase === "deploy_failed" || flow.phase === "retryable_error")
// Binding failures reuse the Bind wallet button (same credential), not Retry→create.

export function passkeyClaimReducer(
	state: PasskeyClaimFlowState,
	event: PasskeyClaimEvent,
): PasskeyClaimFlowState {
	if (state.phase === "expired" && event.type !== "expired")
		return unchanged(state)

	switch (event.type) {
		case "wallet_creation_started":
			if (state.phase !== "idle") return unchanged(state)
			return {
				...state,
				phase: "creating_wallet",
				retry: null,
				message: null,
			}

		case "creation_confirm_needed":
			if (
				state.phase !== "creating_wallet" &&
				state.phase !== "awaiting_creation_confirm"
			)
				return unchanged(state)
			return {
				...state,
				phase: "awaiting_creation_confirm",
				message: null,
			}

		case "creation_confirm_started":
			if (state.phase !== "awaiting_creation_confirm") return unchanged(state)
			return { ...state, message: null }

		case "creation_confirm_dismissed":
			if (state.phase !== "awaiting_creation_confirm") return unchanged(state)
			return {
				...state,
				phase: "awaiting_creation_confirm",
				message: event.message,
			}

		case "creation_confirm_failed":
			if (state.phase !== "awaiting_creation_confirm") return unchanged(state)
			return {
				...state,
				phase: "awaiting_creation_confirm",
				message: event.message,
			}

		case "wallet_created": {
			if (
				state.phase !== "creating_wallet" &&
				state.phase !== "awaiting_creation_confirm"
			)
				return unchanged(state)
			if (!event.contractId.trim() || !event.deployIdempotencyKey.trim())
				return unchanged(state)
			return {
				...state,
				phase: "deploying",
				contractId: event.contractId,
				deployTxHash: null,
				deployIdempotencyKey: event.deployIdempotencyKey,
				message: null,
			}
		}

		case "wallet_creation_failed":
			if (
				state.phase !== "creating_wallet" &&
				state.phase !== "awaiting_creation_confirm"
			)
				return unchanged(state)
			// There is no deploy carrier to retry, so the next attempt is a new ceremony with a
			// fresh passkey and a fresh deploy key; never a replay of an empty deploy.
			return {
				...state,
				phase: "deploy_failed",
				retry: "create",
				message: event.message,
			}

		case "deploy_succeeded":
			if (state.phase !== "deploying") return unchanged(state)
			if (!event.deployTxHash.trim()) return unchanged(state)
			return {
				...state,
				phase: "deployed",
				deployTxHash: event.deployTxHash,
				retry: null,
				message: null,
			}

		case "deploy_failed":
			if (state.phase !== "deploying") return unchanged(state)
			return {
				...state,
				phase: "deploy_failed",
				retry: event.retryable === false ? null : "deploy",
				message: event.message,
			}

		case "wallet_resumed": {
			if (state.phase !== "idle") return unchanged(state)
			if (!event.contractId.trim() || !event.deployTxHash.trim())
				return unchanged(state)
			return {
				...state,
				phase: "deployed",
				contractId: event.contractId,
				deployTxHash: event.deployTxHash,
				deployIdempotencyKey: null,
				retry: null,
				message: null,
			}
		}

		case "bind_started":
			if (state.phase !== "deployed" && state.phase !== "binding_failed")
				return unchanged(state)
			if (!state.contractId || !state.deployTxHash) return unchanged(state)
			return {
				...state,
				phase: "binding",
				retry: null,
				message: null,
				bindDiagnostic: null,
			}

		case "bind_succeeded":
			if (state.phase !== "binding") return unchanged(state)
			return {
				...state,
				phase: "bound",
				retry: null,
				message: null,
				bindDiagnostic: null,
			}

		case "bind_failed":
			if (state.phase !== "binding") return unchanged(state)
			return {
				...state,
				phase: "binding_failed",
				retry: "bind",
				message: event.message,
				bindDiagnostic: event.diagnostic ?? null,
			}

		case "bind_cancelled":
			if (state.phase !== "binding") return unchanged(state)
			// Same credential remains; Bind retry must not create a new wallet.
			return {
				...state,
				phase: "binding_failed",
				retry: "bind",
				message: event.message,
				bindDiagnostic: null,
			}

		case "prepare_started":
			if (state.phase !== "bound" && state.phase !== "retryable_error")
				return unchanged(state)
			if (state.phase === "retryable_error" && state.retry !== "prepare")
				return unchanged(state)
			// A fresh prepare is a new attempt: the previous prepare, its expiration and the old
			// submit key are dropped. The old submit key is never reused for a new prepare.
			return {
				...state,
				phase: "preparing",
				prepareId: null,
				signatureExpirationLedger: null,
				authEntryCount: null,
				submitIdempotencyKey: null,
				releaseTxRef: null,
				pendingTxHash: null,
				apiPaymentStatus: null,
				retry: null,
				message: null,
			}

		case "prepared":
			if (state.phase !== "preparing") return unchanged(state)
			if (
				!event.prepareId.trim() ||
				!Number.isInteger(event.signatureExpirationLedger) ||
				event.signatureExpirationLedger <= 0 ||
				event.authEntryCount < 1
			)
				return unchanged(state)
			return {
				...state,
				phase: "awaiting_signature",
				prepareId: event.prepareId,
				signatureExpirationLedger: event.signatureExpirationLedger,
				authEntryCount: event.authEntryCount,
				message: null,
			}

		case "prepare_failed":
			if (state.phase !== "preparing") return unchanged(state)
			return {
				...state,
				phase: "retryable_error",
				retry: event.retryable === false ? null : "prepare",
				message: event.message,
			}

		case "signing_started":
			if (state.phase !== "awaiting_signature") return unchanged(state)
			return { ...state, phase: "signing", message: null }

		case "signature_dismissed":
			if (state.phase !== "signing") return unchanged(state)
			// The prepare and its entries are still valid: the user can approve again.
			return {
				...state,
				phase: "awaiting_signature",
				message: event.message,
			}

		case "signing_failed":
			if (state.phase !== "signing") return unchanged(state)
			return {
				...state,
				phase: "awaiting_signature",
				message: event.message,
			}

		case "signed":
			if (state.phase !== "signing" || !state.prepareId) return unchanged(state)
			if (!event.submitIdempotencyKey.trim()) return unchanged(state)
			if (state.submitIdempotencyKey) {
				// A submit for this prepare was already signed; never issue a second one.
				return unchanged(state)
			}
			return {
				...state,
				phase: "submitting",
				submitIdempotencyKey: event.submitIdempotencyKey,
				retry: null,
				message: null,
			}

		case "submit_pending": {
			if (state.phase !== "submitting") return unchanged(state)
			if (!/^[a-f0-9]{64}$/.test(event.pendingTxHash)) return unchanged(state)
			return {
				...state,
				phase: "processing",
				pendingTxHash: event.pendingTxHash,
				apiPaymentStatus: event.paymentStatus,
				releaseTxRef: null,
				verified: null,
				retry: null,
				message: null,
			}
		}

		case "submit_settled": {
			if (state.phase !== "submitting") return unchanged(state)
			if (!event.releaseTxRef.trim()) {
				// A 200 without the settle release reference is never shown as success.
				return {
					...state,
					phase: "unconfirmed",
					releaseTxRef: null,
					apiPaymentStatus: event.paymentStatus,
					retry: null,
					message:
						"The claim API did not return a release reference. Nothing here is marked paid.",
				}
			}
			if (event.claimStatus === "accepted" && event.paymentStatus === "paid") {
				return {
					...state,
					phase: "verified",
					releaseTxRef: event.releaseTxRef,
					apiPaymentStatus: event.paymentStatus,
					retry: null,
					message: null,
					verified: {
						claimStatus: "accepted",
						paymentStatus: event.paymentStatus,
					},
				}
			}
			return {
				...state,
				phase: "released",
				releaseTxRef: event.releaseTxRef,
				apiPaymentStatus: event.paymentStatus,
				retry: null,
				message: null,
				verified: null,
			}
		}

		case "submit_retry":
			if (state.phase !== "processing") return unchanged(state)
			if (!state.submitIdempotencyKey || !state.prepareId)
				return unchanged(state)
			return { ...state, phase: "submitting", message: null }

		case "submit_rejected":
			if (state.phase !== "submitting" && state.phase !== "processing")
				return unchanged(state)
			return {
				...state,
				phase: "retryable_error",
				retry: event.retry,
				message: event.message,
			}

		case "retry": {
			if (state.phase === "deploy_failed") {
				if (state.retry === "create") {
					// No carrier exists yet: start a new wallet ceremony, not a deploy replay.
					return {
						...state,
						phase: "creating_wallet",
						contractId: null,
						deployTxHash: null,
						deployIdempotencyKey: null,
						retry: null,
						message: null,
					}
				}
				if (!state.deployIdempotencyKey) return unchanged(state)
				// Same deploy request, same idempotency key: it is a network retry, not a new wallet.
				return {
					...state,
					phase: "deploying",
					retry: null,
					message: null,
				}
			}
			if (state.phase === "binding_failed") {
				if (state.retry !== "bind") return unchanged(state)
				if (!state.contractId || !state.deployTxHash) return unchanged(state)
				// Re-bind the existing credential; never createWallet again.
				return {
					...state,
					phase: "binding",
					retry: null,
					message: null,
				}
			}
			if (state.phase !== "retryable_error") return unchanged(state)
			if (state.retry === "submit") {
				if (!state.submitIdempotencyKey || !state.prepareId)
					return unchanged(state)
				return { ...state, phase: "submitting", retry: null, message: null }
			}
			if (state.retry === "prepare") {
				return {
					...state,
					phase: "preparing",
					prepareId: null,
					signatureExpirationLedger: null,
					authEntryCount: null,
					submitIdempotencyKey: null,
					releaseTxRef: null,
					pendingTxHash: null,
					apiPaymentStatus: null,
					retry: null,
					message: null,
				}
			}
			return unchanged(state)
		}

		case "cancelled":
			// Never hide a submission or release that may already be in flight or confirmed.
			if (
				state.phase === "verified" ||
				state.phase === "released" ||
				state.phase === "submitting" ||
				state.phase === "processing"
			)
				return unchanged(state)
			// Abandoning during Confirm ends createWallet; a later Retry starts a new create.
			return {
				...state,
				phase: "cancelled",
				retry: null,
				prepareId: null,
				signatureExpirationLedger: null,
				authEntryCount: null,
				submitIdempotencyKey: null,
				releaseTxRef: null,
				pendingTxHash: null,
				apiPaymentStatus: null,
				message: null,
				bindDiagnostic: null,
			}

		case "expired":
			if (state.phase === "verified" || state.phase === "released")
				return unchanged(state)
			return {
				...state,
				phase: "expired",
				retry: null,
				submitIdempotencyKey: null,
				releaseTxRef: null,
				pendingTxHash: null,
				apiPaymentStatus: null,
				message: null,
			}
	}
}
