import {
	type PasskeyPrepareResponse,
	type PasskeySubmitRequest,
} from "@flexipay/web-lib/claim-contract"
import {
	isPasskeyWalletConfigured,
	passkeyWalletConfig,
} from "@flexipay/web-lib/passkey-config"
import { useCallback, useEffect, useReducer, useRef } from "react"
import {
	ClaimApiError,
	deployPasskeyWallet,
	describePasskeyDeployError,
	describePasskeyPrepareError,
	describePasskeySubmitError,
	preparePasskeyClaim,
	submitPasskeyClaim,
} from "../../api/claimClient"
import {
	PasskeyWalletError,
	abandonPasskeyCreationAuth,
	bindPasskeyWallet,
	clearPasskeyResumeRecord,
	confirmPasskeyCreationAuth,
	createPasskeyWallet,
	forgetPasskeyWallet,
	releasePasskeyWalletMemory,
	rememberPasskeyDeploy,
	resumePasskeyWallet,
	signPasskeyClaimAuthEntries,
} from "../../api/passkeyWallet"
import {
	initialPasskeyFlow,
	isPasskeySupported,
	passkeyClaimReducer,
} from "./passkey-claim-flow"

// Controller for the CCR-21 passkey claim: create → deploy → Bind (explicit click) → prepare →
// sign → submit. Binding never auto-starts after create; Bind retries reuse the same credential.
// Reload can resume Bind from public tab-scoped store facts (see passkeyWallet).
//
// Secret-bearing values (unsigned and signed auth entries) live only in this controller's
// in-memory refs: never React state, never logs, never browser storage. A network retry of the
// same submit reuses the identical body and Idempotency-Key; a new prepare gets a new key.

export interface UsePasskeyClaimOptions {
	token: string
}

interface DeployCarrier {
	key: string
	request: {
		contractId: string
		keyIdBase64: string
		signedTx: string
	}
}

interface PreparedClaim {
	prepareId: string
	contractId: string
	unsignedEntries: string[]
	signatureExpirationLedger: number
	/** Same-key submit body once signed; cleared by a new prepare. */
	submit: { key: string; body: PasskeySubmitRequest } | null
}

export interface PasskeyClaimController {
	flow: ReturnType<typeof passkeyClaimReducer>
	create: () => void
	/** Confirm with passkey — real startAuthentication from this click (same createWallet). */
	confirmCreation: () => void
	bind: () => void
	prepare: () => void
	approve: () => void
	checkRelease: () => void
	retry: () => void
	cancel: () => void
}

const initialFlow = () =>
	initialPasskeyFlow({
		deployAvailable: isPasskeyWalletConfigured,
		supported: isPasskeySupported(),
	})

const walletFailureMessage = (cause: unknown): string =>
	cause instanceof PasskeyWalletError
		? cause.message
		: "The passkey wallet could not be created on this device."

export function usePasskeyClaim({
	token,
}: UsePasskeyClaimOptions): PasskeyClaimController {
	const [flow, dispatch] = useReducer(
		passkeyClaimReducer,
		undefined,
		initialFlow,
	)
	// Signed deploy carrier and its idempotency key, kept for a retry of the *same* deploy.
	const carrier = useRef<DeployCarrier | null>(null)
	// Prepare result and the signed submit body for this prepare; in memory only.
	const prepared = useRef<PreparedClaim | null>(null)
	const abort = useRef<AbortController | null>(null)
	// Monotonic attempt id: a result that belongs to a cancelled attempt is ignored.
	const attempt = useRef(0)
	const creating = useRef(false)
	const confirmingCreation = useRef(false)
	const deploying = useRef(false)
	const binding = useRef(false)
	const preparing = useRef(false)
	const signing = useRef(false)
	const submitting = useRef(false)
	const tokenRef = useRef(token)

	useEffect(() => {
		const previous = tokenRef.current
		tokenRef.current = token
		let cancelled = false

		void (async () => {
			if (previous !== token) {
				await clearPasskeyResumeRecord(previous)
				forgetPasskeyWallet()
			} else {
				releasePasskeyWalletMemory()
			}
			carrier.current = null
			prepared.current = null
			const resumed = await resumePasskeyWallet(token)
			if (cancelled || !resumed) return
			dispatch({
				type: "wallet_resumed",
				contractId: resumed.contractId,
				deployTxHash: resumed.deployTxHash,
			})
		})()

		return () => {
			cancelled = true
			abort.current?.abort()
			prepared.current = null
			carrier.current = null
			// Keep public resume facts in the tab store so a reload can restore Bind.
			releasePasskeyWalletMemory()
		}
	}, [token])

	const sendDeploy = useCallback(
		async (attemptId: number) => {
			const pending = carrier.current
			if (!pending || deploying.current) return
			deploying.current = true
			const controller = new AbortController()
			abort.current = controller

			try {
				const response = await deployPasskeyWallet(
					token,
					pending.request,
					pending.key,
					controller.signal,
				)
				if (attempt.current !== attemptId) return
				carrier.current = null
				await rememberPasskeyDeploy(response.deployTxHash, token)
				if (attempt.current !== attemptId) return
				dispatch({
					type: "deploy_succeeded",
					deployTxHash: response.deployTxHash,
				})
			} catch (cause) {
				if (attempt.current !== attemptId || controller.signal.aborted) return
				if (cause instanceof ClaimApiError) {
					const failure = describePasskeyDeployError(cause)
					if (failure.expired) {
						carrier.current = null
						dispatch({ type: "expired" })
						return
					}
					if (cause.code === "contract_mismatch") {
						// Drop the mismatched in-memory ceremony; keep any earlier resume record.
						carrier.current = null
						releasePasskeyWalletMemory()
					}
					dispatch({
						type: "deploy_failed",
						message: failure.message,
						retryable: failure.retryable,
					})
					return
				}
				dispatch({
					type: "deploy_failed",
					message:
						"The passkey wallet could not be deployed. No wallet was confirmed by the claim API.",
					retryable: true,
				})
			} finally {
				deploying.current = false
				if (abort.current === controller) abort.current = null
			}
		},
		[token],
	)

	const runCreate = useCallback(
		async (attemptId: number) => {
			if (creating.current) return
			creating.current = true
			try {
				const wallet = await createPasskeyWallet({
					onAwaitingCreationConfirm: () => {
						if (attempt.current !== attemptId) return
						dispatch({ type: "creation_confirm_needed" })
					},
				})
				if (attempt.current !== attemptId) return
				const pending: DeployCarrier = {
					key: `claim-passkey-deploy-${crypto.randomUUID()}`,
					request: {
						contractId: wallet.contractId,
						keyIdBase64: wallet.keyIdBase64,
						signedTx: wallet.signedTx,
					},
				}
				carrier.current = pending
				dispatch({
					type: "wallet_created",
					contractId: pending.request.contractId,
					deployIdempotencyKey: pending.key,
				})
				await sendDeploy(attemptId)
			} catch (cause) {
				if (attempt.current !== attemptId) return
				if (cause instanceof PasskeyWalletError && cause.code === "cancelled") {
					carrier.current = null
					dispatch({ type: "cancelled" })
					return
				}
				dispatch({
					type: "wallet_creation_failed",
					message: walletFailureMessage(cause),
				})
			} finally {
				creating.current = false
			}
		},
		[sendDeploy],
	)

	const sendSubmit = useCallback(
		async (attemptId: number) => {
			const pending = prepared.current?.submit
			if (!pending || submitting.current) return
			submitting.current = true
			const controller = new AbortController()
			abort.current = controller

			try {
				const outcome = await submitPasskeyClaim(
					token,
					pending.body,
					pending.key,
					controller.signal,
				)
				if (attempt.current !== attemptId) return
				if (outcome.status === "pending") {
					dispatch({
						type: "submit_pending",
						pendingTxHash: outcome.body.pendingTxHash,
						paymentStatus: outcome.body.paymentStatus,
					})
					return
				}
				dispatch({
					type: "submit_settled",
					claimStatus: outcome.body.claim.status,
					paymentStatus: outcome.body.paymentStatus,
					releaseTxRef: outcome.body.releaseTxRef,
				})
			} catch (cause) {
				if (attempt.current !== attemptId || controller.signal.aborted) return
				if (cause instanceof ClaimApiError) {
					const failure = describePasskeySubmitError(cause)
					if (failure.expired) {
						prepared.current = null
						dispatch({ type: "expired" })
						return
					}
					dispatch({
						type: "submit_rejected",
						message: failure.message,
						retry: failure.retry,
					})
					return
				}
				dispatch({
					type: "submit_rejected",
					message:
						"The claim release could not be confirmed. Refresh the claim to see its actual state.",
					retry: null,
				})
			} finally {
				submitting.current = false
				if (abort.current === controller) abort.current = null
			}
		},
		[token],
	)

	const runPrepare = useCallback(
		async (attemptId: number, contractId: string) => {
			if (preparing.current || !contractId) return
			preparing.current = true
			try {
				const response: PasskeyPrepareResponse = await preparePasskeyClaim(
					token,
					{ contractId },
				)
				if (attempt.current !== attemptId) return
				if (
					response.networkPassphrase !== passkeyWalletConfig.networkPassphrase
				) {
					dispatch({
						type: "prepare_failed",
						message:
							"The claim API prepared the signature for a different Stellar network. Nothing was signed.",
						retryable: false,
					})
					return
				}
				prepared.current = {
					prepareId: response.prepareId,
					contractId,
					unsignedEntries: response.authEntries,
					signatureExpirationLedger: response.signatureExpirationLedger,
					submit: null,
				}
				dispatch({
					type: "prepared",
					prepareId: response.prepareId,
					signatureExpirationLedger: response.signatureExpirationLedger,
					authEntryCount: response.authEntries.length,
				})
			} catch (cause) {
				if (attempt.current !== attemptId) return
				if (cause instanceof ClaimApiError) {
					const failure = describePasskeyPrepareError(cause)
					if (failure.expired) {
						dispatch({ type: "expired" })
						return
					}
					dispatch({
						type: "prepare_failed",
						message: failure.message,
						retryable: failure.retry === "prepare",
					})
					return
				}
				dispatch({
					type: "prepare_failed",
					message: "The claim signature could not be prepared.",
					retryable: true,
				})
			} finally {
				preparing.current = false
			}
		},
		[token],
	)

	const runSignAndSubmit = useCallback(
		async (attemptId: number) => {
			const pending = prepared.current
			if (!pending || signing.current) return
			if (pending.submit) {
				// Already signed for this prepare: never produce a second submit body.
				dispatch({
					type: "signed",
					submitIdempotencyKey: pending.submit.key,
				})
				await sendSubmit(attemptId)
				return
			}
			signing.current = true
			try {
				const signedAuthEntries = await signPasskeyClaimAuthEntries({
					authEntries: pending.unsignedEntries,
					signatureExpirationLedger: pending.signatureExpirationLedger,
				})
				if (attempt.current !== attemptId) return
				if (signedAuthEntries.length !== pending.unsignedEntries.length) {
					dispatch({
						type: "signing_failed",
						message:
							"The passkey signature did not cover every prepared entry. Nothing was submitted.",
					})
					return
				}
				const submit = {
					key: `claim-passkey-submit-${crypto.randomUUID()}`,
					body: {
						prepareId: pending.prepareId,
						contractId: pending.contractId,
						signedAuthEntries,
					},
				}
				pending.submit = submit
				dispatch({
					type: "signed",
					submitIdempotencyKey: submit.key,
				})
				await sendSubmit(attemptId)
			} catch (cause) {
				if (attempt.current !== attemptId) return
				if (cause instanceof PasskeyWalletError && cause.code === "cancelled") {
					dispatch({
						type: "signature_dismissed",
						message:
							"The signature was dismissed. The prepared claim is still valid, so you can approve again.",
					})
					return
				}
				dispatch({
					type: "signing_failed",
					message:
						cause instanceof PasskeyWalletError
							? cause.message
							: "The claim signature could not be made on this device.",
				})
			} finally {
				signing.current = false
			}
		},
		[sendSubmit],
	)

	const create = useCallback(() => {
		if (!isPasskeyWalletConfigured || creating.current || deploying.current)
			return
		const attemptId = ++attempt.current
		carrier.current = null
		prepared.current = null
		dispatch({ type: "wallet_creation_started" })
		void runCreate(attemptId)
	}, [runCreate])

	/**
	 * Confirm with passkey click: starts the real startAuthentication in this gesture and
	 * continues the same createWallet. Never calls createWallet / startRegistration again.
	 */
	const confirmCreation = useCallback(() => {
		if (confirmingCreation.current) return
		if (flow.phase !== "awaiting_creation_confirm") return
		confirmingCreation.current = true
		dispatch({ type: "creation_confirm_started" })
		void confirmPasskeyCreationAuth()
			.then((outcome) => {
				if (outcome === "dismissed") {
					dispatch({
						type: "creation_confirm_dismissed",
						message:
							"Confirmation was dismissed. The same passkey is still available — tap Confirm with passkey again. No new credential is created.",
					})
					return
				}
				if (outcome === "failed") {
					dispatch({
						type: "creation_confirm_failed",
						message:
							"Confirmation failed. Tap Confirm with passkey to retry with the same registration. No new credential is created.",
					})
					return
				}
				// completed | busy | idle: createWallet continues or nothing to do
			})
			.finally(() => {
				confirmingCreation.current = false
			})
	}, [flow.phase])

	/**
	 * Explicit Bind wallet click. Starts the binding ceremony on the click stack without an
	 * intervening module-load await (kit already held from create/resume). Never calls createWallet.
	 */
	const bind = useCallback(() => {
		if (binding.current || creating.current || deploying.current) return
		if (
			flow.phase !== "deployed" &&
			flow.phase !== "binding_failed" &&
			flow.phase !== "binding"
		)
			return
		if (flow.phase === "binding") return
		if (!flow.contractId || !flow.deployTxHash) return

		binding.current = true
		const attemptId = attempt.current
		dispatch({ type: "bind_started" })
		// Kick off immediately from the gesture; first awaits are confirm/connect only.
		void bindPasskeyWallet()
			.then(() => {
				if (attempt.current !== attemptId) return
				dispatch({ type: "bind_succeeded" })
			})
			.catch((cause: unknown) => {
				if (attempt.current !== attemptId) return
				if (cause instanceof PasskeyWalletError && cause.code === "cancelled") {
					dispatch({
						type: "bind_cancelled",
						message:
							"The bind prompt was dismissed. The same passkey is still available — tap Bind wallet to try again.",
					})
					return
				}
				dispatch({
					type: "bind_failed",
					message:
						cause instanceof PasskeyWalletError
							? cause.message
							: "The passkey wallet could not be bound on this device.",
					diagnostic:
						cause instanceof PasskeyWalletError
							? (cause.bindDiagnostic ?? null)
							: null,
				})
			})
			.finally(() => {
				binding.current = false
			})
	}, [flow.phase, flow.contractId, flow.deployTxHash])

	const prepare = useCallback(() => {
		if (flow.phase !== "bound" && flow.phase !== "retryable_error") return
		if (!flow.contractId || preparing.current || binding.current) return
		const attemptId = ++attempt.current
		prepared.current = null
		dispatch({ type: "prepare_started" })
		void runPrepare(attemptId, flow.contractId)
	}, [flow.phase, flow.contractId, runPrepare])

	const approve = useCallback(() => {
		if (signing.current || submitting.current || binding.current) return
		if (flow.phase !== "awaiting_signature" && flow.phase !== "signing") return
		const attemptId = attempt.current
		dispatch({ type: "signing_started" })
		void runSignAndSubmit(attemptId)
	}, [flow.phase, runSignAndSubmit])

	const checkRelease = useCallback(() => {
		if (flow.phase !== "processing" || submitting.current) return
		if (!prepared.current?.submit) return
		dispatch({ type: "submit_retry" })
		void sendSubmit(attempt.current)
	}, [flow.phase, sendSubmit])

	const retry = useCallback(() => {
		if (
			creating.current ||
			deploying.current ||
			binding.current ||
			preparing.current
		)
			return
		if (flow.phase === "deploy_failed" && flow.retry === "create") {
			const attemptId = ++attempt.current
			carrier.current = null
			prepared.current = null
			dispatch({ type: "retry" })
			void runCreate(attemptId)
			return
		}
		if (flow.phase === "deploy_failed" && flow.retry === "deploy") {
			dispatch({ type: "retry" })
			void sendDeploy(attempt.current)
			return
		}
		// Binding retries go through bind(), never createWallet.
		if (flow.phase !== "retryable_error") return
		if (flow.retry === "prepare") {
			if (!flow.contractId) return
			const attemptId = ++attempt.current
			prepared.current = null
			dispatch({ type: "retry" })
			void runPrepare(attemptId, flow.contractId)
			return
		}
		if (flow.retry === "submit") {
			if (!prepared.current?.submit) return
			dispatch({ type: "retry" })
			void sendSubmit(attempt.current)
		}
	}, [
		flow.phase,
		flow.retry,
		flow.contractId,
		runCreate,
		sendDeploy,
		runPrepare,
		sendSubmit,
	])

	const cancel = useCallback(() => {
		attempt.current += 1
		abort.current?.abort()
		abort.current = null
		creating.current = false
		confirmingCreation.current = false
		binding.current = false
		abandonPasskeyCreationAuth()
		carrier.current = null
		prepared.current = null
		forgetPasskeyWallet(token)
		dispatch({ type: "cancelled" })
	}, [token])

	return {
		flow,
		create,
		confirmCreation,
		bind,
		prepare,
		approve,
		checkRelease,
		retry,
		cancel,
	}
}
