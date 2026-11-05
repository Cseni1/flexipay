import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react"

/**
 * Playwright-only stand-in for @crossmint/client-sdk-react-ui.
 * Enabled via FP_CROSSMINT_SDK_STUB=1 on the Vite webServer — no real Crossmint calls.
 *
 * Covers embedded checkout (card) and embedded Solana wallet (email auth).
 * Auth is persisted in sessionStorage so Pay-from and SolanaPayPanel provider
 * trees share the same signed-in session (mirrors Crossmint JWT restore).
 */

/** Valid base58 Solana pubkey (wrapped-SOL mint) used as the stub wallet address. */
export const STUB_ADDRESS = "So11111111111111111111111111111111111111112"
export const FLEXIPAY_STUB_SIGNATURE =
	"5FlexiPayStubSigaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const AUTH_STORAGE_KEY = "fp.crossmint.stub.auth"

type AuthStatus = "logged-in" | "logged-out" | "in-progress" | "initializing"
type WalletStatus = "not-loaded" | "in-progress" | "loaded" | "error"

type StubAuth = {
	login: (defaultEmail?: string) => void
	logout: () => Promise<void>
	loginWithOAuth: () => Promise<void>
	status: AuthStatus
	user?: { id: string; email?: string }
	jwt?: string
	getUser: () => void
}

type StubWalletInstance = {
	address: string
	balances: () => Promise<{
		usdc: { amount: string; decimals: number }
		nativeToken: { amount: string }
		tokens: unknown[]
	}>
	sendTransaction: (params: unknown) => Promise<{
		hash: string
		explorerLink: string
		transactionId: string
	}>
}

type StubWallet = {
	wallet: StubWalletInstance | undefined
	status: WalletStatus
	getWallet: () => Promise<unknown>
	createWallet: () => Promise<unknown>
	error: null
}

const AuthCtx = createContext<StubAuth | null>(null)
const WalletCtx = createContext<StubWallet | null>(null)

const readStoredEmail = (): string | null => {
	try {
		const raw = sessionStorage.getItem(AUTH_STORAGE_KEY)
		return raw && raw.includes("@") ? raw : null
	} catch {
		return null
	}
}

const writeStoredEmail = (email: string | null) => {
	try {
		if (!email) sessionStorage.removeItem(AUTH_STORAGE_KEY)
		else sessionStorage.setItem(AUTH_STORAGE_KEY, email)
	} catch {
		/* ignore */
	}
}

export function CrossmintProvider({ children }: { children?: ReactNode }) {
	return <>{children}</>
}

export function CrossmintAuthProvider({
	children,
}: {
	children?: ReactNode
	loginMethods?: string[]
	appearance?: unknown
}) {
	const stored = readStoredEmail()
	const [status, setStatus] = useState<AuthStatus>(
		stored ? "logged-in" : "logged-out",
	)
	const [email, setEmail] = useState<string | undefined>(stored ?? undefined)

	useEffect(() => {
		const onStorage = (event: StorageEvent) => {
			if (event.storageArea !== sessionStorage) return
			if (event.key !== AUTH_STORAGE_KEY) return
			const next = event.newValue
			if (next && next.includes("@")) {
				setEmail(next)
				setStatus("logged-in")
			} else {
				setEmail(undefined)
				setStatus("logged-out")
			}
		}
		window.addEventListener("storage", onStorage)
		return () => window.removeEventListener("storage", onStorage)
	}, [])

	const login = useCallback((defaultEmail?: string) => {
		setStatus("in-progress")
		const nextEmail =
			typeof defaultEmail === "string" && defaultEmail.includes("@")
				? defaultEmail
				: "stub@flexipay.test"
		queueMicrotask(() => {
			writeStoredEmail(nextEmail)
			setEmail(nextEmail)
			setStatus("logged-in")
		})
	}, [])

	const logout = useCallback(async () => {
		writeStoredEmail(null)
		setEmail(undefined)
		setStatus("logged-out")
	}, [])

	const value = useMemo<StubAuth>(
		() => ({
			login,
			logout,
			loginWithOAuth: async () => undefined,
			status,
			user: status === "logged-in" ? { id: "stub_user", email } : undefined,
			jwt: status === "logged-in" ? "stub_jwt" : undefined,
			getUser: () => undefined,
		}),
		[login, logout, status, email],
	)

	return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

export function CrossmintWalletProvider({
	children,
}: {
	children?: ReactNode
	createOnLogin?: unknown
	appearance?: unknown
	showPasskeyHelpers?: boolean
	showOtpSignerPrompt?: boolean
	callbacks?: unknown
}) {
	const auth = useContext(AuthCtx)
	const loggedIn = auth?.status === "logged-in"

	const value = useMemo<StubWallet>(() => {
		if (!loggedIn) {
			return {
				wallet: undefined,
				status: "not-loaded",
				getWallet: async () => undefined,
				createWallet: async () => undefined,
				error: null,
			}
		}
		const wallet: StubWalletInstance = {
			address: STUB_ADDRESS,
			balances: async () => ({
				usdc: { amount: "12.5", decimals: 6 },
				nativeToken: { amount: "0.1" },
				tokens: [{ symbol: "tGBP", amount: "25.00", mint: "TgbpDevMint" }],
			}),
			sendTransaction: async () => ({
				hash: FLEXIPAY_STUB_SIGNATURE,
				explorerLink: `https://explorer.solana.com/tx/${FLEXIPAY_STUB_SIGNATURE}?cluster=devnet`,
				transactionId: "tx_stub_flexipay",
			}),
		}
		return {
			wallet,
			status: "loaded",
			getWallet: async () => wallet,
			createWallet: async () => wallet,
			error: null,
		}
	}, [loggedIn])

	return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>
}

export function useCrossmintAuth(): StubAuth {
	const ctx = useContext(AuthCtx)
	if (!ctx) {
		throw new Error("useCrossmintAuth requires CrossmintAuthProvider (stub)")
	}
	return ctx
}

export function useWallet(): StubWallet {
	const ctx = useContext(WalletCtx)
	if (!ctx) {
		throw new Error("useWallet requires CrossmintWalletProvider (stub)")
	}
	return ctx
}

export function CrossmintEmbeddedCheckout(props: {
	orderId: string
	clientSecret: string
	payment?: unknown
}) {
	return (
		<div data-testid="crossmint-embedded-stub">
			Crossmint checkout stub (order {props.orderId})
		</div>
	)
}

export type ClientSideWalletCreateArgs<C extends string = string> = {
	chain: C
	recoveryMethods?: Array<{ type: string; email?: string }>
	signers?: unknown[]
}

export type Chain = string
export type Wallet<C extends string = string> = StubWalletInstance & {
	chain?: C
}

/** Minimal stand-in so production imports of SolanaWallet type-check under the stub. */
export const SolanaWallet = {
	from: (wallet: StubWalletInstance) => wallet,
}
