import {
	PASSKEY_WALLET_APP_NAME,
	PASSKEY_WALLET_USER_NAME,
	isPasskeyWalletConfigured,
	passkeyWalletConfig,
} from "@flexipay/web-lib/passkey-config"
import {
	createPasskeyWebAuthnGate,
	type CreationAuthSnapshot,
	type PasskeyWebAuthnGate,
} from "./passkeyWebAuthnGate"

// Types come from the lazy loader: no value import, so the kit stays a lazy chunk.
const loadKitModule = () => import("passkey-kit")
const loadSimpleWebAuthn = () => import("@simplewebauthn/browser")
type KitModule = Awaited<ReturnType<typeof loadKitModule>>
type PasskeyKit = InstanceType<KitModule["PasskeyKit"]>
type CreateWalletResult = Awaited<ReturnType<PasskeyKit["createWallet"]>>

// The only place in the web app that touches passkey-kit, loaded on demand so the claim page
// does not ship the wallet SDK to visitors who never create a wallet.
//
// createWallet uses the kit's supported custom `WebAuthn` client: startRegistration is unchanged;
// the post-registration startAuthentication (Genesis binding proof) is gated behind an explicit
// Confirm with passkey click so the authenticator runs from that user gesture. Deploy-time Bind
// wallet remains a separate later step.

export type PasskeyWalletErrorCode =
	"unsupported" | "cancelled" | "not_configured" | "no_wallet" | "failed"

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

export interface CreatePasskeyWalletHooks {
	/** Fired when createWallet parks for the Confirm with passkey click. */
	onAwaitingCreationConfirm?: () => void
}

interface ActiveWallet {
	kit: PasskeyKit
	created: CreateWalletResult
	contractId: string
	keyIdBase64: string
	deployTxHash: string | null
	/** True after confirmWalletCreation + connectWallet from an explicit Bind click. */
	bound: boolean
}

/** In-memory only: the created passkey wallet for this page session. */
let active: ActiveWallet | null = null
/** Active gate for the in-flight createWallet (null when idle). */
let creationGate: PasskeyWebAuthnGate | null = null

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
			"The passkey prompt was dismissed. Nothing was signed.",
		)
	}
	if (errorCode(cause) === WEBAUTHN_NOT_SUPPORTED) {
		return new PasskeyWalletError(
			"unsupported",
			"This browser cannot use a passkey.",
		)
	}
	return new PasskeyWalletError(
		"failed",
		"The passkey wallet could not be used on this device.",
	)
}

export function getCreationAuthSnapshot(): CreationAuthSnapshot | null {
	return creationGate?.snapshot() ?? null
}

export function subscribeCreationAuth(
	listener: () => void,
): (() => void) | null {
	return creationGate?.subscribe(listener) ?? null
}

/**
 * Call from the Confirm with passkey click handler. Starts the real
 * `startAuthentication` in that gesture; continues the same createWallet.
 */
export async function confirmPasskeyCreationAuth(): Promise<
	"completed" | "dismissed" | "failed" | "busy" | "idle"
> {
	if (!creationGate) return "idle"
	return creationGate.confirmCreationAuthentication()
}

/** Abandon the parked creation authentication (and the in-flight createWallet). */
export function abandonPasskeyCreationAuth(): void {
	creationGate?.abandonCreationAuthentication(
		Object.assign(new Error("Passkey confirmation was cancelled."), {
			name: "NotAllowedError",
		}),
	)
}

export async function createPasskeyWallet(
	hooks: CreatePasskeyWalletHooks = {},
): Promise<CreatedPasskeyWallet> {
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

	let created: CreateWalletResult
	let kit: PasskeyKit
	let gate: PasskeyWebAuthnGate | null = null
	try {
		const [{ PasskeyKit }, simple] = await Promise.all([
			loadKitModule(),
			loadSimpleWebAuthn(),
		])
		gate = createPasskeyWebAuthnGate({
			startRegistration: (args) => simple.startRegistration(args),
			startAuthentication: (args) => simple.startAuthentication(args),
			onAwaitingConfirm: hooks.onAwaitingCreationConfirm,
			isCancellation,
		})
		creationGate = gate
		gate.beginCreationGate()
		kit = new PasskeyKit({
			...passkeyWalletConfig,
			WebAuthn: gate.client,
		})
		created = await kit.createWallet(
			PASSKEY_WALLET_APP_NAME,
			PASSKEY_WALLET_USER_NAME,
		)
	} catch (cause) {
		active = null
		gate?.endCreationGate()
		creationGate = null
		throw toWalletError(cause)
	} finally {
		gate?.endCreationGate()
		if (creationGate === gate) creationGate = null
	}

	const { contractId, keyIdBase64, signedTx } = created
	if (!contractId || !keyIdBase64 || !signedTx) {
		active = null
		throw new PasskeyWalletError(
			"failed",
			"The passkey wallet kit returned an incomplete deploy carrier.",
		)
	}
	active = {
		kit,
		created,
		contractId,
		keyIdBase64,
		deployTxHash: null,
		bound: false,
	}
	return { contractId, keyIdBase64, signedTx }
}

/**
 * Records the API-confirmed deploy hash for the in-memory wallet. Binding and signing are
 * refused until the API confirmed the deploy, so a pending/unknown deploy can never proceed.
 */
export function rememberPasskeyDeploy(deployTxHash: string): void {
	if (active) {
		active.deployTxHash = deployTxHash
		active.bound = false
	}
}

/** Drops the in-memory wallet (token change or logout); never persisted anywhere. */
export function forgetPasskeyWallet(): void {
	abandonPasskeyCreationAuth()
	active = null
	creationGate = null
}

/**
 * Binds the already-created credential to the API-confirmed deploy.
 *
 * Must be started from a user click: this function does not await module loads first — the kit
 * from createWallet stays in memory — so confirmWalletCreation / connectWallet keep the gesture.
 * Never calls createWallet. Cancel or failure leaves the same credential for a Bind retry.
 */
export async function bindPasskeyWallet(): Promise<void> {
	const wallet = active
	if (!wallet) {
		throw new PasskeyWalletError(
			"no_wallet",
			"This page no longer holds the passkey wallet. A reload cannot resume it; use a crypto wallet address instead.",
		)
	}
	if (!wallet.deployTxHash) {
		throw new PasskeyWalletError(
			"no_wallet",
			"The wallet deploy is not confirmed yet, so the passkey was not bound.",
		)
	}
	if (wallet.bound) return

	try {
		await wallet.kit.confirmWalletCreation(wallet.created, wallet.deployTxHash)
		await wallet.kit.connectWallet({ keyId: wallet.keyIdBase64 })
		wallet.bound = true
	} catch (cause) {
		wallet.bound = false
		throw toWalletError(cause)
	}
}

export interface SignPasskeyClaimInput {
	/** Unsigned Soroban auth entries from prepare (base64 XDR, secret-bearing). */
	authEntries: string[]
	/** The exact ledger prepare returned; any other value is rejected on submit. */
	signatureExpirationLedger: number
}

/**
 * Signs the prepared claim auth entries with the passkey created in this session.
 *
 * `signAuthEntry` is called with `expiration: signatureExpirationLedger` exactly as CCR-21
 * requires. The signed entries carry the vault claim secret, so they are returned to the caller
 * and never logged or stored.
 */
export async function signPasskeyClaimAuthEntries({
	authEntries,
	signatureExpirationLedger,
}: SignPasskeyClaimInput): Promise<string[]> {
	const wallet = active
	if (!wallet) {
		throw new PasskeyWalletError(
			"no_wallet",
			"This page no longer holds the passkey wallet. A reload cannot resume it; use a crypto wallet address instead.",
		)
	}
	if (!wallet.deployTxHash) {
		throw new PasskeyWalletError(
			"no_wallet",
			"The wallet deploy is not confirmed yet, so no claim signature was made.",
		)
	}
	if (!wallet.bound) {
		throw new PasskeyWalletError(
			"no_wallet",
			"Bind the passkey wallet before approving the claim. Nothing was signed.",
		)
	}
	if (authEntries.length === 0) {
		throw new PasskeyWalletError(
			"failed",
			"The claim signature request was empty.",
		)
	}

	try {
		const [{ PasskeySigner }, { decodeAuthEntryXdr, encodeAuthEntryXdr }] =
			await Promise.all([
				loadKitModule(),
				import("@flexipay/web-lib/passkey-auth"),
			])

		const entries = authEntries.map((entry) => decodeAuthEntryXdr(entry))
		const signer = new PasskeySigner(wallet.keyIdBase64)
		const signed: string[] = []
		for (const entry of entries) {
			const signedEntry = await wallet.kit.signAuthEntry(entry, signer, {
				expiration: signatureExpirationLedger,
			})
			signed.push(encodeAuthEntryXdr(signedEntry))
		}
		return signed
	} catch (cause) {
		throw toWalletError(cause)
	}
}
