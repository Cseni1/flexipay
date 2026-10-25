import { type PasskeyDeployRequest } from "@flexipay/web-lib/claim-contract"
import { isPasskeyWalletConfigured } from "@flexipay/web-lib/passkey-config"
import { useCallback, useEffect, useReducer, useRef } from "react"
import {
	ClaimApiError,
	deployPasskeyWallet,
	describePasskeyDeployError,
} from "../../api/claimClient"
import {
	PasskeyWalletError,
	createPasskeyWallet,
} from "../../api/passkeyWallet"
import {
	initialPasskeyFlow,
	isPasskeySupported,
	passkeyClaimReducer,
} from "./passkey-claim-flow"

// Controller for the passkey deploy: one passkey ceremony, one deploy carrier, one idempotency
// key. It never logs, stores or re-sends a carrier under a new key, and it never calls the
// prepare/submit routes (still stubs on the API branch).

export interface UsePasskeyClaimOptions {
	token: string
}

interface DeployCarrier {
	key: string
	request: PasskeyDeployRequest
}

export interface PasskeyClaimController {
	flow: ReturnType<typeof passkeyClaimReducer>
	create: () => void
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
	const abort = useRef<AbortController | null>(null)
	// Monotonic attempt id: a result that belongs to a cancelled attempt is ignored.
	const attempt = useRef(0)
	const creating = useRef(false)
	const deploying = useRef(false)

	useEffect(
		() => () => {
			abort.current?.abort()
		},
		[],
	)

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
				const wallet = await createPasskeyWallet()
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

	const create = useCallback(() => {
		if (!isPasskeyWalletConfigured || creating.current || deploying.current)
			return
		const attemptId = ++attempt.current
		carrier.current = null
		dispatch({ type: "wallet_creation_started" })
		void runCreate(attemptId)
	}, [runCreate])

	const retry = useCallback(() => {
		if (creating.current || deploying.current) return
		if (flow.phase === "deploy_failed" && flow.retry === "create") {
			const attemptId = ++attempt.current
			carrier.current = null
			dispatch({ type: "retry" })
			void runCreate(attemptId)
			return
		}
		if (flow.phase === "deploy_failed" && flow.retry === "deploy") {
			dispatch({ type: "retry" })
			void sendDeploy(attempt.current)
		}
		// Prepare/submit retries are not wired: those routes do not exist yet.
	}, [flow.phase, flow.retry, runCreate, sendDeploy])

	const cancel = useCallback(() => {
		attempt.current += 1
		abort.current?.abort()
		abort.current = null
		creating.current = false
		carrier.current = null
		dispatch({ type: "cancelled" })
	}, [])

	return { flow, create, retry, cancel }
}
