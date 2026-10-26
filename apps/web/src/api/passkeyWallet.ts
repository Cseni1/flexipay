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
//
// After the API confirms deploy, ONLY public wallet facts are kept in sessionStorage (contractId,
// keyIdBase64, publicKey base64, deployTxHash), keyed by a SHA-256 of the claim token — never the
// raw token, signedTx, auth entries, claim secret, or other carriers. Storage access is try/catch;
// a blocked store still allows the in-memory flow. Reload can resume Bind from those public facts.

export type PasskeyWalletErrorCode =
	"unsupported" | "cancelled" | "not_configured" | "no_wallet" | "failed"

/** Which Bind kit call threw; never includes XDR, secrets, or tx hashes. */
export type PasskeyBindStep = "confirmWalletCreation" | "connectWallet"

/** Short, non-sensitive Bind failure facts for UI + console. */
export interface PasskeyBindDiagnostic {
	step: PasskeyBindStep
	/** Kit / DOM error class name (e.g. WalletOwnershipError). */
	errorName: string
	/** PasskeyKitErrorCode numeric value or string code when present. */
	errorCode: string | number | null
	/** Optional short context.reason from the kit (no hashes/XDR). */
	reason: string | null
	/** Optional short context.detail when it passes the sensitivity filter. */
	detail: string | null
	/** DOMException / Error name from context.cause when present. */
	causeName: string | null
	/** DOMException / Error message from context.cause when non-sensitive. */
	causeMessage: string | null
	/** window.location.hostname at Bind time. */
	hostname: string | null
	/** rpId the kit was constructed with. */
	rpId: string | null
	/** allowedOrigins the kit was constructed with. */
	allowedOrigins: string[] | null
	/** Deployed contract id only — the sole hash-like field allowed here. */
	contractId: string
}

export class PasskeyWalletError extends Error {
	readonly code: PasskeyWalletErrorCode
	readonly bindDiagnostic?: PasskeyBindDiagnostic

	constructor(
		code: PasskeyWalletErrorCode,
		message: string,
		options?: { bindDiagnostic?: PasskeyBindDiagnostic },
	) {
		super(message)
		this.name = "PasskeyWalletError"
		this.code = code
		if (options?.bindDiagnostic) this.bindDiagnostic = options.bindDiagnostic
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

export interface ResumedPasskeyWallet {
	contractId: string
	deployTxHash: string
}

interface ActiveWallet {
	kit: PasskeyKit
	created: CreateWalletResult
	contractId: string
	keyIdBase64: string
	deployTxHash: string | null
	/** True after confirmWalletCreation + connectWallet from an explicit Bind click. */
	bound: boolean
	rpId: string | null
	allowedOrigins: string[] | null
}

const browserPasskeyOrigins = (): {
	rpId: string | null
	allowedOrigins: string[] | null
} => {
	if (typeof window === "undefined") return { rpId: null, allowedOrigins: null }
	const hostname = window.location.hostname.trim()
	const origin = window.location.origin.trim()
	return {
		rpId: hostname || null,
		allowedOrigins: origin ? [origin] : null,
	}
}

/** Public deploy facts only — never signedTx / auth / secrets / raw claim token. */
interface StoredPasskeyResume {
	v: 1
	contractId: string
	keyIdBase64: string
	/** SEC-1 P-256 public key as standard base64 (not a secret). */
	publicKey: string
	deployTxHash: string
}

const STORAGE_PREFIX = "fp.passkey.resume.v1."

/** In-memory wallet for this page session (plus optional public resume record). */
let active: ActiveWallet | null = null
/** Active gate for the in-flight createWallet (null when idle). */
let creationGate: PasskeyWebAuthnGate | null = null
/** sessionStorage key for the active claim's public resume record, when known. */
let activeStorageKey: string | null = null

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

const toWalletError = (
	cause: unknown,
	options?: { bindDiagnostic?: PasskeyBindDiagnostic },
): PasskeyWalletError => {
	if (cause instanceof PasskeyWalletError) {
		if (options?.bindDiagnostic && !cause.bindDiagnostic) {
			return new PasskeyWalletError(cause.code, cause.message, {
				bindDiagnostic: options.bindDiagnostic,
			})
		}
		return cause
	}
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
		options,
	)
}

const looksSensitiveFragment = (value: string): boolean =>
	/signedTx|authEntr|secret|Bearer|S[A-Z2-7]{55}|[a-f0-9]{64}|AAAA/i.test(
		value,
	) || value.length > 160

const safeContextString = (value: unknown): string | null => {
	if (typeof value !== "string") return null
	const trimmed = value.trim()
	if (!trimmed || looksSensitiveFragment(trimmed)) return null
	return trimmed
}

/** Extract kit class / code / reason / detail / cause without sensitive context. */
export function describePasskeyBindCause(cause: unknown): {
	errorName: string
	errorCode: string | number | null
	reason: string | null
	detail: string | null
	causeName: string | null
	causeMessage: string | null
} {
	if (typeof cause !== "object" || cause === null) {
		return {
			errorName: "Error",
			errorCode: null,
			reason: null,
			detail: null,
			causeName: null,
			causeMessage: null,
		}
	}
	const errorName =
		cause instanceof Error && cause.name.trim() ? cause.name : "Error"
	const rawCode =
		"code" in cause ? (cause as { code: unknown }).code : undefined
	const errorCode =
		typeof rawCode === "number" || typeof rawCode === "string" ? rawCode : null
	let reason: string | null = null
	let detail: string | null = null
	let causeName: string | null = null
	let causeMessage: string | null = null
	const context =
		"context" in cause ? (cause as { context?: unknown }).context : undefined
	if (context && typeof context === "object" && context !== null) {
		reason = safeContextString((context as { reason?: unknown }).reason)
		detail = safeContextString((context as { detail?: unknown }).detail)
		const nested =
			"cause" in context ? (context as { cause?: unknown }).cause : undefined
		if (nested && typeof nested === "object" && nested !== null) {
			const nestedName =
				nested instanceof Error
					? nested.name
					: "name" in nested
						? String((nested as { name: unknown }).name)
						: ""
			causeName = nestedName.trim() || null
			const nestedMessage =
				nested instanceof Error
					? nested.message
					: "message" in nested
						? String((nested as { message: unknown }).message)
						: ""
			causeMessage = safeContextString(nestedMessage)
		}
	}
	// Also accept Error.cause (DOMException) when context.cause is absent.
	if (!causeName && cause instanceof Error && cause.cause) {
		const nested = cause.cause
		if (nested && typeof nested === "object") {
			const nestedName =
				nested instanceof Error
					? nested.name
					: "name" in nested
						? String((nested as { name: unknown }).name)
						: ""
			causeName = nestedName.trim() || null
			const nestedMessage =
				nested instanceof Error
					? nested.message
					: "message" in nested
						? String((nested as { message: unknown }).message)
						: ""
			causeMessage = safeContextString(nestedMessage)
		}
	}
	return { errorName, errorCode, reason, detail, causeName, causeMessage }
}

const logBindDiagnostic = (diagnostic: PasskeyBindDiagnostic): void => {
	// Intentional operator diagnostic: class/code/step/contractId only — no XDR/keys/tokens.
	console.warn("[passkey-bind]", diagnostic)
}

const bytesToBase64 = (bytes: Uint8Array): string => {
	let binary = ""
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
}

const base64ToBytes = (value: string): Uint8Array => {
	const binary = atob(value)
	const out = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
	return out
}

const base64urlToBytes = (value: string): Uint8Array => {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/")
	const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4))
	return base64ToBytes(padded + pad)
}

async function claimTokenHashHex(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	)
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")
}

async function storageKeyForClaim(token: string): Promise<string> {
	return `${STORAGE_PREFIX}${await claimTokenHashHex(token)}`
}

const readStoredResume = (key: string): StoredPasskeyResume | null => {
	try {
		const raw = sessionStorage.getItem(key)
		if (!raw) return null
		const parsed = JSON.parse(raw) as Partial<StoredPasskeyResume>
		if (
			parsed.v !== 1 ||
			typeof parsed.contractId !== "string" ||
			!parsed.contractId.trim() ||
			typeof parsed.keyIdBase64 !== "string" ||
			!parsed.keyIdBase64.trim() ||
			typeof parsed.publicKey !== "string" ||
			!parsed.publicKey.trim() ||
			typeof parsed.deployTxHash !== "string" ||
			!/^[a-f0-9]{64}$/i.test(parsed.deployTxHash)
		)
			return null
		return {
			v: 1,
			contractId: parsed.contractId,
			keyIdBase64: parsed.keyIdBase64,
			publicKey: parsed.publicKey,
			deployTxHash: parsed.deployTxHash.toLowerCase(),
		}
	} catch {
		return null
	}
}

const writeStoredResume = (key: string, record: StoredPasskeyResume): void => {
	try {
		sessionStorage.setItem(key, JSON.stringify(record))
	} catch {
		// Storage blocked or full: in-memory flow continues without resume.
	}
}

const removeStoredKey = (key: string): void => {
	try {
		sessionStorage.removeItem(key)
	} catch {
		// ignore
	}
}

const clearActiveStorageRecord = (): void => {
	if (!activeStorageKey) return
	removeStoredKey(activeStorageKey)
	activeStorageKey = null
}

/** Public field names allowed in a resume record (tests assert this set). */
export const PASSKEY_RESUME_STORAGE_KEYS = [
	"v",
	"contractId",
	"keyIdBase64",
	"publicKey",
	"deployTxHash",
] as const

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

/**
 * Drops only the in-memory wallet (and creation gate). Does not touch sessionStorage so a
 * reload can still resume Bind from public deploy facts.
 */
export function releasePasskeyWalletMemory(): void {
	abandonPasskeyCreationAuth()
	active = null
	creationGate = null
}

/**
 * Drops the in-memory wallet and clears this page's public resume record when known.
 * Pass `claimToken` to clear that claim's record even when memory was already released.
 */
export function forgetPasskeyWallet(claimToken?: string): void {
	releasePasskeyWalletMemory()
	clearActiveStorageRecord()
	if (claimToken) {
		void storageKeyForClaim(claimToken)
			.then((key) => {
				removeStoredKey(key)
				if (activeStorageKey === key) activeStorageKey = null
			})
			.catch(() => {})
	}
}

/** Clears the public resume record for a claim token (token change). Memory is untouched. */
export async function clearPasskeyResumeRecord(
	claimToken: string,
): Promise<void> {
	try {
		const key = await storageKeyForClaim(claimToken)
		removeStoredKey(key)
		if (activeStorageKey === key) activeStorageKey = null
	} catch {
		// ignore
	}
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
		const origins = browserPasskeyOrigins()
		const kit = new PasskeyKit({
			...passkeyWalletConfig,
			...(origins.rpId ? { rpId: origins.rpId } : {}),
			...(origins.allowedOrigins
				? { allowedOrigins: origins.allowedOrigins }
				: {}),
			WebAuthn: gate.client,
		})
		const created = await kit.createWallet(
			PASSKEY_WALLET_APP_NAME,
			PASSKEY_WALLET_USER_NAME,
		)
		const { contractId, keyIdBase64, signedTx, publicKey } = created
		if (!contractId || !keyIdBase64 || !signedTx || !publicKey?.length) {
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
			rpId: origins.rpId,
			allowedOrigins: origins.allowedOrigins,
		}
		return { contractId, keyIdBase64, signedTx }
	} catch (cause) {
		active = null
		gate?.endCreationGate()
		creationGate = null
		throw toWalletError(cause)
	} finally {
		gate?.endCreationGate()
		if (creationGate === gate) creationGate = null
	}
}

/**
 * Records the API-confirmed deploy hash for the in-memory wallet and persists ONLY public
 * facts for Bind resume after reload. Binding and signing are refused until the API confirmed
 * the deploy, so a pending/unknown deploy can never proceed.
 */
export async function rememberPasskeyDeploy(
	deployTxHash: string,
	claimToken: string,
): Promise<void> {
	if (!active) return
	const hash = deployTxHash.trim().toLowerCase()
	if (!/^[a-f0-9]{64}$/.test(hash)) return
	active.deployTxHash = hash
	active.bound = false
	try {
		const key = await storageKeyForClaim(claimToken)
		activeStorageKey = key
		const publicKey = active.created.publicKey
		if (!publicKey?.length) return
		writeStoredResume(key, {
			v: 1,
			contractId: active.contractId,
			keyIdBase64: active.keyIdBase64,
			publicKey: bytesToBase64(publicKey),
			deployTxHash: hash,
		})
	} catch {
		// Storage or hashing unavailable: keep in-memory deploy only.
	}
}

/**
 * Rebuilds the in-memory wallet from public sessionStorage facts for this claim (if any).
 * Bind remains a separate explicit click. Returns null when nothing is stored or storage fails.
 */
export async function resumePasskeyWallet(
	claimToken: string,
): Promise<ResumedPasskeyWallet | null> {
	if (!hasWebAuthn() || !isPasskeyWalletConfigured) return null
	let key: string
	try {
		key = await storageKeyForClaim(claimToken)
	} catch {
		return null
	}
	const record = readStoredResume(key)
	if (!record) return null

	try {
		const { PasskeyKit } = await loadKitModule()
		const publicKey = base64ToBytes(record.publicKey)
		const keyId = base64urlToBytes(record.keyIdBase64)
		const origins = browserPasskeyOrigins()
		const kit = new PasskeyKit({
			...passkeyWalletConfig,
			...(origins.rpId ? { rpId: origins.rpId } : {}),
			...(origins.allowedOrigins
				? { allowedOrigins: origins.allowedOrigins }
				: {}),
		})
		const created = {
			rawResponse: {
				id: record.keyIdBase64,
				rawId: record.keyIdBase64,
				response: {
					clientDataJSON: "",
					attestationObject: "",
				},
				clientExtensionResults: {},
				type: "public-key",
			},
			keyId,
			keyIdBase64: record.keyIdBase64,
			publicKey,
			contractId: record.contractId,
			// Deploy already confirmed by the API; Bind never resubmits this carrier.
			signedTx: "",
		} as CreateWalletResult
		active = {
			kit,
			created,
			contractId: record.contractId,
			keyIdBase64: record.keyIdBase64,
			deployTxHash: record.deployTxHash,
			bound: false,
			rpId: origins.rpId,
			allowedOrigins: origins.allowedOrigins,
		}
		activeStorageKey = key
		return {
			contractId: record.contractId,
			deployTxHash: record.deployTxHash,
		}
	} catch {
		active = null
		return null
	}
}

/**
 * Binds the already-created (or resumed) credential to the API-confirmed deploy.
 *
 * Must be started from a user click: this function does not await module loads first — the kit
 * from createWallet/resume stays in memory — so confirmWalletCreation / connectWallet keep the
 * gesture. Never calls createWallet. Cancel or failure leaves the same credential for a Bind retry.
 */
export async function bindPasskeyWallet(): Promise<void> {
	const wallet = active
	if (!wallet) {
		throw new PasskeyWalletError(
			"no_wallet",
			"This page no longer holds the passkey wallet. If this browser still has the deploy record, reload to resume Bind; otherwise use a crypto wallet address instead.",
		)
	}
	if (!wallet.deployTxHash) {
		throw new PasskeyWalletError(
			"no_wallet",
			"The wallet deploy is not confirmed yet, so the passkey was not bound.",
		)
	}
	if (wallet.bound) return

	let step: PasskeyBindStep = "confirmWalletCreation"
	try {
		await wallet.kit.confirmWalletCreation(wallet.created, wallet.deployTxHash)
		step = "connectWallet"
		await wallet.kit.connectWallet({ keyId: wallet.keyIdBase64 })
		wallet.bound = true
	} catch (cause) {
		wallet.bound = false
		if (isCancellation(cause)) throw toWalletError(cause)
		const meta = describePasskeyBindCause(cause)
		const bindDiagnostic: PasskeyBindDiagnostic = {
			step,
			errorName: meta.errorName,
			errorCode: meta.errorCode,
			reason: meta.reason,
			detail: meta.detail,
			causeName: meta.causeName,
			causeMessage: meta.causeMessage,
			hostname:
				typeof window !== "undefined" ? window.location.hostname || null : null,
			rpId: wallet.rpId,
			allowedOrigins: wallet.allowedOrigins,
			contractId: wallet.contractId,
		}
		logBindDiagnostic(bindDiagnostic)
		throw toWalletError(cause, { bindDiagnostic })
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
			"This page no longer holds the passkey wallet. If this browser still has the deploy record, reload to resume Bind; otherwise use a crypto wallet address instead.",
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
