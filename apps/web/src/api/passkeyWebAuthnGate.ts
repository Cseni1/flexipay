/**
 * Gated WebAuthn client for passkey-kit's supported `WebAuthn` injection.
 *
 * During createWallet, registration runs normally. The post-registration
 * `startAuthentication` (Genesis binding proof) is parked until
 * {@link confirmCreationAuthentication} runs from a user click — the real
 * authenticator call starts in that click handler, not in a Promise continuation
 * after resolving a waiter. Outside the creation gate, authentication is passthrough
 * (Bind / sign).
 */

import {
	type AuthenticationResponseJSON,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	type RegistrationResponseJSON,
} from "@simplewebauthn/browser"

/** Matches passkey-kit's `WebAuthnClient` (kit/webauthn-ops). */
export interface WebAuthnClientSurface {
	startRegistration(args: {
		optionsJSON: PublicKeyCredentialCreationOptionsJSON
	}): Promise<RegistrationResponseJSON>
	startAuthentication(args: {
		optionsJSON: PublicKeyCredentialRequestOptionsJSON
	}): Promise<AuthenticationResponseJSON>
}

export type CreationAuthPhase =
	"idle" | "awaiting_confirm" | "authenticating" | "dismissed" | "failed"

export interface CreationAuthSnapshot {
	phase: CreationAuthPhase
	/** True while createWallet is inside the gated window. */
	gateOpen: boolean
	registrationCount: number
	authenticationCount: number
	/** Options parked for the Confirm click; never logged by callers. */
	hasParkedOptions: boolean
}

interface ParkedCreationAuth {
	optionsJSON: PublicKeyCredentialRequestOptionsJSON
	resolve: (value: AuthenticationResponseJSON) => void
	reject: (reason: unknown) => void
	authInFlight: boolean
}

export interface PasskeyWebAuthnGate {
	client: WebAuthnClientSurface
	beginCreationGate: () => void
	endCreationGate: () => void
	/** Call from the Confirm click handler only. */
	confirmCreationAuthentication: () => Promise<
		"completed" | "dismissed" | "failed" | "busy" | "idle"
	>
	/** Abandon the in-flight createWallet (rejects parked auth). */
	abandonCreationAuthentication: (reason?: Error) => void
	snapshot: () => CreationAuthSnapshot
	subscribe: (listener: () => void) => () => void
}

export interface CreatePasskeyWebAuthnGateOptions {
	startRegistration: WebAuthnClientSurface["startRegistration"]
	startAuthentication: WebAuthnClientSurface["startAuthentication"]
	onAwaitingConfirm?: () => void
	isCancellation?: (cause: unknown) => boolean
}

const defaultIsCancellation = (cause: unknown): boolean => {
	const name =
		cause instanceof Error
			? cause.name
			: typeof cause === "object" && cause !== null && "name" in cause
				? String((cause as { name: unknown }).name)
				: ""
	if (name === "NotAllowedError" || name === "AbortError") return true
	const inner =
		typeof cause === "object" && cause !== null && "cause" in cause
			? (cause as { cause: unknown }).cause
			: undefined
	return inner instanceof Error
		? inner.name === "NotAllowedError" || inner.name === "AbortError"
		: false
}

export function createPasskeyWebAuthnGate(
	options: CreatePasskeyWebAuthnGateOptions,
): PasskeyWebAuthnGate {
	const isCancellation = options.isCancellation ?? defaultIsCancellation
	let gateOpen = false
	let parked: ParkedCreationAuth | null = null
	let phase: CreationAuthPhase = "idle"
	let registrationCount = 0
	let authenticationCount = 0
	const listeners = new Set<() => void>()

	const notify = (): void => {
		for (const listener of listeners) listener()
	}

	const setPhase = (next: CreationAuthPhase): void => {
		phase = next
		notify()
	}

	const client: WebAuthnClientSurface = {
		async startRegistration(args) {
			registrationCount += 1
			notify()
			return options.startRegistration(args)
		},
		startAuthentication(args) {
			if (!gateOpen) {
				authenticationCount += 1
				notify()
				return options.startAuthentication(args)
			}
			// Park options for the Confirm click. Do not call the authenticator here.
			if (parked) {
				return Promise.reject(
					new Error(
						"A creation authentication is already waiting for Confirm with passkey.",
					),
				)
			}
			return new Promise<AuthenticationResponseJSON>((resolve, reject) => {
				parked = {
					optionsJSON: args.optionsJSON,
					resolve,
					reject,
					authInFlight: false,
				}
				setPhase("awaiting_confirm")
				options.onAwaitingConfirm?.()
			})
		},
	}

	return {
		client,
		beginCreationGate() {
			gateOpen = true
			parked = null
			setPhase("idle")
		},
		endCreationGate() {
			gateOpen = false
			if (parked && !parked.authInFlight) {
				const waiting = parked
				parked = null
				waiting.reject(
					new Error("Passkey creation ended before authentication completed."),
				)
			}
			if (
				phase === "awaiting_confirm" ||
				phase === "dismissed" ||
				phase === "failed"
			) {
				setPhase("idle")
			}
		},
		async confirmCreationAuthentication() {
			const waiting = parked
			if (!waiting) return "idle"
			if (waiting.authInFlight) return "busy"

			waiting.authInFlight = true
			setPhase("authenticating")
			try {
				// First await is the authenticator — options already prepared; no prior load.
				const response = await options.startAuthentication({
					optionsJSON: waiting.optionsJSON,
				})
				authenticationCount += 1
				parked = null
				waiting.resolve(response)
				setPhase("idle")
				return "completed"
			} catch (cause) {
				waiting.authInFlight = false
				if (isCancellation(cause)) {
					// Keep the same parked options / createWallet; Confirm can be pressed again.
					setPhase("dismissed")
					return "dismissed"
				}
				setPhase("failed")
				return "failed"
			}
		},
		abandonCreationAuthentication(reason) {
			const waiting = parked
			parked = null
			gateOpen = false
			if (waiting) {
				waiting.reject(
					reason ??
						Object.assign(new Error("Passkey confirmation was cancelled."), {
							name: "NotAllowedError",
						}),
				)
			}
			setPhase("idle")
		},
		snapshot: () => ({
			phase,
			gateOpen,
			registrationCount,
			authenticationCount,
			hasParkedOptions: parked !== null,
		}),
		subscribe(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
	}
}
