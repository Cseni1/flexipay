// Passkey claim UI state for the M2 milestone.
//
// CCR-20 is accepted and its deploy route is mounted on the event API branch. Wallet creation and
// `POST /v1/claims/{token}/passkey/deploy` are wired through the hook next to this module; this
// reducer stays pure and holds UI state only.
//
// Prepare and submit are still stubs on that branch, so the deployed phase deliberately has no
// prepare action: the UI says claim signing is unavailable and offers the working G-address
// claim instead. The extra phases below stay so the eventual binding can reuse the reducer, and
// the DEV gallery renders them from fixtures only.
//
// Security rules encoded here: a deploy or submit is started once per attempt, a network retry
// reuses the same idempotency key, and expiry blocks approval and submit.

export type PasskeyClaimPhase =
	/** No accepted contract/backend yet: the production default. */
	| "unavailable"
	/** The browser has no WebAuthn support. */
	| "unsupported"
	| "idle"
	| "creating_wallet"
	| "deploying"
	| "deployed"
	| "deploy_failed"
	| "preparing"
	| "awaiting_signature"
	| "submitting"
	| "processing"
	| "verified"
	| "unconfirmed"
	| "cancelled"
	| "expired"
	| "retryable_error"

/** Which step a retry would repeat. `create` needs a fresh passkey ceremony and a new key. */
export type PasskeyRetryTarget = "create" | "deploy" | "prepare" | "submit"

export interface PasskeyVerifiedClaim {
	claimStatus: "accepted"
	paymentStatus: string
}

export interface PasskeyClaimFlowState {
	phase: PasskeyClaimPhase
	contractId: string | null
	/** Ledger-confirmed deploy hash returned by the API; never a fabricated one. */
	deployTxHash: string | null
	prepareId: string | null
	deployIdempotencyKey: string | null
	submitIdempotencyKey: string | null
	retry: PasskeyRetryTarget | null
	message: string | null
	verified: PasskeyVerifiedClaim | null
}

export type PasskeyClaimEvent =
	| { type: "wallet_creation_started" }
	| {
			type: "wallet_created"
			contractId: string
			deployIdempotencyKey: string
	  }
	| { type: "deploy_succeeded"; deployTxHash: string }
	| { type: "deploy_failed"; message: string; retryable?: boolean }
	| { type: "wallet_creation_failed"; message: string }
	| { type: "prepare_started" }
	| { type: "prepared"; prepareId: string }
	| { type: "signature_approved"; submitIdempotencyKey: string }
	| {
			type: "submit_accepted"
			claimStatus: string
			paymentStatus: string
	  }
	| { type: "submit_rejected"; message: string; retryable: boolean }
	| { type: "retry" }
	| { type: "cancelled" }
	| { type: "expired" }

const BUSY_PHASES = new Set<PasskeyClaimPhase>([
	"creating_wallet",
	"deploying",
	"preparing",
	"submitting",
	"processing",
])

const TERMINAL_PHASES = new Set<PasskeyClaimPhase>([
	"unavailable",
	"unsupported",
	"verified",
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
	deployIdempotencyKey: null,
	submitIdempotencyKey: null,
	retry: null,
	message: null,
	verified: null,
})

const unchanged = (state: PasskeyClaimFlowState): PasskeyClaimFlowState => state

export const isPasskeyBusy = (phase: PasskeyClaimPhase): boolean =>
	BUSY_PHASES.has(phase)

export const isPasskeyTerminal = (phase: PasskeyClaimPhase): boolean =>
	TERMINAL_PHASES.has(phase)

export const canCreatePasskeyWallet = (flow: PasskeyClaimFlowState): boolean =>
	flow.phase === "idle"

export const canPreparePasskeyClaim = (flow: PasskeyClaimFlowState): boolean =>
	flow.phase === "deployed"

/** Approval and submit are both refused once the claim is no longer open at `expiresAt`. */
export const canApprovePasskeyClaim = (
	flow: PasskeyClaimFlowState,
	claimExpired: boolean,
): boolean => flow.phase === "awaiting_signature" && !claimExpired

export const canRetryPasskeyStep = (
	flow: PasskeyClaimFlowState,
	claimExpired: boolean,
): boolean =>
	!claimExpired &&
	flow.retry !== null &&
	(flow.phase === "deploy_failed" || flow.phase === "retryable_error")

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

		case "wallet_created": {
			if (state.phase !== "creating_wallet") return unchanged(state)
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
			if (state.phase !== "creating_wallet") return unchanged(state)
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

		case "prepare_started":
			if (state.phase !== "deployed") return unchanged(state)
			// A fresh prepare is a new attempt: the previous prepare and submit key are dropped,
			// and the backend contract decides the idempotency behaviour of the next submit.
			return {
				...state,
				phase: "preparing",
				prepareId: null,
				submitIdempotencyKey: null,
				retry: null,
				message: null,
			}

		case "prepared":
			if (state.phase !== "preparing") return unchanged(state)
			if (!event.prepareId.trim()) return unchanged(state)
			return {
				...state,
				phase: "awaiting_signature",
				prepareId: event.prepareId,
				message: null,
			}

		case "signature_approved":
			if (state.phase !== "awaiting_signature" || !state.prepareId)
				return unchanged(state)
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

		case "submit_accepted": {
			if (state.phase !== "submitting" && state.phase !== "processing")
				return unchanged(state)
			if (event.claimStatus === "accepted" && event.paymentStatus === "paid") {
				return {
					...state,
					phase: "verified",
					retry: null,
					message: null,
					verified: {
						claimStatus: "accepted",
						paymentStatus: event.paymentStatus,
					},
				}
			}
			if (event.claimStatus === "accepted")
				return { ...state, phase: "processing", retry: null, message: null }
			// A 200 that does not say the claim is accepted is never shown as success.
			return {
				...state,
				phase: "unconfirmed",
				retry: null,
				message:
					"The claim API did not confirm the claim as accepted. Nothing here is marked paid.",
			}
		}

		case "submit_rejected":
			if (state.phase !== "submitting" && state.phase !== "processing")
				return unchanged(state)
			return {
				...state,
				phase: "retryable_error",
				retry: event.retryable ? "submit" : null,
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
					submitIdempotencyKey: null,
					retry: null,
					message: null,
				}
			}
			return unchanged(state)
		}

		case "cancelled":
			// Never hide a submission that may already be in flight.
			if (
				state.phase === "verified" ||
				state.phase === "submitting" ||
				state.phase === "processing"
			)
				return unchanged(state)
			return {
				...state,
				phase: "cancelled",
				retry: null,
				prepareId: null,
				submitIdempotencyKey: null,
				message: null,
			}

		case "expired":
			if (state.phase === "verified") return unchanged(state)
			return {
				...state,
				phase: "expired",
				retry: null,
				submitIdempotencyKey: null,
				message: null,
			}
	}
}
