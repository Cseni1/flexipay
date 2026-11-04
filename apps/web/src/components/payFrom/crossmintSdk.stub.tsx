import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useState,
	type ReactNode,
} from "react"

/**
 * Playwright-only stand-in for @crossmint/client-sdk-react-ui.
 * Enabled via FP_CROSSMINT_SDK_STUB=1 on the Vite webServer — no real Crossmint calls.
 *
 * Covers embedded checkout (card) and embedded Solana wallet (email auth).
 */

const STUB_ADDRESS = "FpStubWallet1111111111111111111111111111111"

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

type StubWallet = {
	wallet:
		| {
				address: string
				balances: () => Promise<{
					usdc: { amount: string; decimals: number }
					nativeToken: { amount: string }
					tokens: unknown[]
				}>
		  }
		| undefined
	status: WalletStatus
	getWallet: () => Promise<unknown>
	createWallet: () => Promise<unknown>
	error: null
}

const AuthCtx = createContext<StubAuth | null>(null)
const WalletCtx = createContext<StubWallet | null>(null)

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
	const [status, setStatus] = useState<AuthStatus>("logged-out")
	const [email, setEmail] = useState<string | undefined>()

	const login = useCallback((defaultEmail?: string) => {
		setStatus("in-progress")
		const nextEmail =
			typeof defaultEmail === "string" && defaultEmail.includes("@")
				? defaultEmail
				: "stub@flexipay.test"
		queueMicrotask(() => {
			setEmail(nextEmail)
			setStatus("logged-in")
		})
	}, [])

	const logout = useCallback(async () => {
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
		const wallet = {
			address: STUB_ADDRESS,
			balances: async () => ({
				usdc: { amount: "12.5", decimals: 6 },
				nativeToken: { amount: "0.1" },
				tokens: [],
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
