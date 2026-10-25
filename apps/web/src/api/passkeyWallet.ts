import {
	PASSKEY_WALLET_APP_NAME,
	PASSKEY_WALLET_USER_NAME,
	isPasskeyWalletConfigured,
	passkeyWalletConfig,
} from "@flexipay/web-lib/passkey-config"

// The only place in the web app that touches passkey-kit, loaded on demand so the claim page
// does not ship the wallet SDK to visitors who never create a wallet. `createWallet` registers a
// passkey with the platform authenticator and returns the shared-deployer carrier that the claim
// API rebuilds with its own payer:
//
//   keyIdBase64 — base64url WebAuthn credential id (not standard base64)
//   signedTx    — standard base64 Transaction envelope XDR (not base64url)
//   contractId  — the deterministic C… wallet address for that credential
//
// The carrier is not secret-bearing, but it is never logged or stored: it goes straight into the
// deploy request and stays in memory for an idempotent retry.

export type PasskeyWalletErrorCode =
	"unsupported" | "cancelled" | "not_configured" | "failed"

export class PasskeyWalletError extends Error {
	readonly code: PasskeyWalletErrorCode

	constructor(code: PasskeyWalletErrorCode, message: string) {
		super(message)
		this.name = "PasskeyWalletError"
		this.code = code
	}
}

export interface CreatedPasskeyWallet {
	contractId: string
	keyIdBase64: string
	signedTx: string
}

/** passkey-kit error codes (WebAuthn range); kept numeric to avoid importing the SDK eagerly. */
const WEBAUTHN_NOT_SUPPORTED = 3003
const WEBAUTHN_CANCELLED = 3004

const hasWebAuthn = (): boolean =>
	typeof window !== "undefined" &&
	typeof window.PublicKeyCredential === "function"

const errorCode = (cause: unknown): number | undefined => {
	if (typeof cause !== "object" || cause === null || !("code" in cause))
		return undefined
	const code = (cause as { code: unknown }).code
	return typeof code === "number" ? code : undefined
}

const isCancellation = (cause: unknown): boolean => {
	if (errorCode(cause) === WEBAUTHN_CANCELLED) return true
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

const toWalletError = (cause: unknown): PasskeyWalletError => {
	if (cause instanceof PasskeyWalletError) return cause
	if (isCancellation(cause)) {
		return new PasskeyWalletError(
			"cancelled",
			"The passkey prompt was dismissed. No wallet was deployed.",
		)
	}
	if (errorCode(cause) === WEBAUTHN_NOT_SUPPORTED) {
		return new PasskeyWalletError(
			"unsupported",
			"This browser cannot create a passkey.",
		)
	}
	// Kit messages can mention RPC or contract details; the UI gets a stable, payload-free copy.
	return new PasskeyWalletError(
		"failed",
		"The passkey wallet could not be created on this device.",
	)
}

export async function createPasskeyWallet(): Promise<CreatedPasskeyWallet> {
	if (!hasWebAuthn()) {
		throw new PasskeyWalletError(
			"unsupported",
			"This browser cannot create a passkey wallet.",
		)
	}
	if (!isPasskeyWalletConfigured) {
		throw new PasskeyWalletError(
			"not_configured",
			"Passkey wallets are not configured in this build.",
		)
	}

	let created: CreatedPasskeyWallet
	try {
		const { PasskeyKit } = await import("passkey-kit")
		const kit = new PasskeyKit(passkeyWalletConfig)
		created = await kit.createWallet(
			PASSKEY_WALLET_APP_NAME,
			PASSKEY_WALLET_USER_NAME,
		)
	} catch (cause) {
		throw toWalletError(cause)
	}

	const { contractId, keyIdBase64, signedTx } = created
	if (!contractId || !keyIdBase64 || !signedTx) {
		throw new PasskeyWalletError(
			"failed",
			"The passkey wallet kit returned an incomplete deploy carrier.",
		)
	}
	return { contractId, keyIdBase64, signedTx }
}
