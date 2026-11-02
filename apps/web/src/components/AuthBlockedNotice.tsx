import { Link } from "react-router-dom"
import { useSession } from "../providers/SessionProvider"
import { Notice } from "./ui"

/**
 * Shown when the API answered 401. A signed-in customer needs to sign in again; the local
 * dev proxy (no session) keeps its server-side API key explanation.
 */
export function AuthBlockedNotice() {
	const { viaSession } = useSession()
	if (viaSession)
		return (
			<Notice tone="warning" data-testid="session-ended">
				Your sign-in has ended. <Link to="/login">Sign in again</Link> to
				continue.
			</Notice>
		)
	return (
		<Notice tone="warning">
			The local API proxy could not authenticate. Set the server-side FP_API_KEY
			for Vite, then restart the dev server.
		</Notice>
	)
}
