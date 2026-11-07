import bs58 from "bs58"
import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react"

/**
 * Playwright-only stand-in for @privy-io/react-auth and @privy-io/react-auth/solana.
 * Enabled via FP_PRIVY_SDK_STUB=1 on the Vite webServer: no Privy calls, no keys.
 * Sign-in is kept in sessionStorage so Pay-from and the Solana pay panel share it.
 */

/** Valid base58 Solana pubkey (wrapped-SOL mint) used as the stub wallet address. */
export const STUB_ADDRESS = "So11111111111111111111111111111111111111112"
/** Valid base58, so it survives the bytes round trip the real Privy hook uses. */
export const FLEXIPAY_STUB_SIGNATURE =
	"5FexiPayStubSigaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const AUTH_KEY = "fp.privy.stub.auth"

const readSignedIn = (): boolean => {
	try {
		return sessionStorage.getItem(AUTH_KEY) === "1"
	} catch {
		return false
	}
}

const writeSignedIn = (on: boolean) => {
	try {
		if (on) sessionStorage.setItem(AUTH_KEY, "1")
		else sessionStorage.removeItem(AUTH_KEY)
	} catch {
		/* ignore */
	}
}

function useStubAuth() {
	const [authenticated, setAuthenticated] = useState(readSignedIn)
	useEffect(() => {
		const sync = () => setAuthenticated(readSignedIn())
		window.addEventListener("fp-privy-stub", sync)
		window.addEventListener("storage", sync)
		return () => {
			window.removeEventListener("fp-privy-stub", sync)
			window.removeEventListener("storage", sync)
		}
	}, [])
	return authenticated
}

const notify = () => window.dispatchEvent(new Event("fp-privy-stub"))

export function PrivyProvider({
	children,
}: {
	children?: ReactNode
	appId?: string
	config?: unknown
}) {
	return <>{children}</>
}

export function usePrivy() {
	const authenticated = useStubAuth()
	const login = useCallback(() => {
		queueMicrotask(() => {
			writeSignedIn(true)
			notify()
		})
	}, [])
	const logout = useCallback(async () => {
		writeSignedIn(false)
		notify()
	}, [])
	return useMemo(
		() => ({
			ready: true,
			authenticated,
			login,
			logout,
			user: authenticated ? { email: { address: "stub@flexipay.test" } } : null,
		}),
		[authenticated, login, logout],
	)
}

export function useWallets() {
	const authenticated = useStubAuth()
	return useMemo(
		() => ({
			ready: true,
			wallets: authenticated ? [{ address: STUB_ADDRESS }] : [],
		}),
		[authenticated],
	)
}

export function useSignAndSendTransaction() {
	return {
		signAndSendTransaction: async (_input: unknown) => ({
			signature: bs58.decode(FLEXIPAY_STUB_SIGNATURE),
		}),
	}
}
