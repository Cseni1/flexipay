import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from "react"
import { Navigate, useLocation } from "react-router-dom"
import { fetchSession, signOut, type SessionInfo } from "../api/auth"

// TASK 06: who is using the app. `signed_in` covers both a customer session and the local
// proxy's server-side key (/v1/me reports which), so the local demo keeps working.

type SessionState =
	| { status: "loading" }
	| { status: "signed_out" }
	| { status: "unconfigured" }
	| { status: "signed_in"; session: SessionInfo }
	| { status: "error" }

interface SessionApi {
	state: SessionState
	refresh: () => Promise<void>
	logout: () => Promise<void>
}

const Ctx = createContext<SessionApi | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<SessionState>({ status: "loading" })

	const refresh = useCallback(async () => {
		try {
			const session = await fetchSession()
			setState(
				session === "unconfigured"
					? { status: "unconfigured" }
					: session
						? { status: "signed_in", session }
						: { status: "signed_out" },
			)
		} catch {
			setState({ status: "error" })
		}
	}, [])

	useEffect(() => {
		void refresh()
	}, [refresh])

	const logout = useCallback(async () => {
		try {
			await signOut()
		} finally {
			setState({ status: "signed_out" })
		}
	}, [])

	const value = useMemo(
		() => ({ state, refresh, logout }),
		[state, refresh, logout],
	)
	return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSession(): SessionApi {
	const v = useContext(Ctx)
	if (!v) throw new Error("useSession must be used inside SessionProvider")
	return v
}

/** Sends visitors without a session to /login; renders children once signed in. */
export function RequireSession({ children }: { children: ReactNode }) {
	const { state } = useSession()
	const location = useLocation()
	if (state.status === "loading")
		return (
			<p className="form-note" aria-busy="true">
				Loading...
			</p>
		)
	if (state.status === "signed_out")
		return <Navigate to="/login" replace state={{ from: location.pathname }} />
	if (state.status === "error")
		return (
			<p className="form-note" role="alert">
				The server could not be reached. Check that the API is running, then
				reload.
			</p>
		)
	return <>{children}</>
}
