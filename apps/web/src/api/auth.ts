// TASK 06: customer sign-in client. Same-origin calls to /api/auth/* (Better Auth) and /v1/me.
// The session lives in an HttpOnly cookie the browser handles; this code never sees or stores a
// token, and never handles FP_API_KEY or any provider secret.

export interface SessionInfo {
	via: "api_key" | "session"
	organization: { id: string; name: string }
	user: { id: string; email: string; name: string } | null
}

export class AuthRequestError extends Error {
	readonly status: number
	readonly code: string
	constructor(status: number, code: string, message: string) {
		super(message)
		this.name = "AuthRequestError"
		this.status = status
		this.code = code
	}
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null

async function authFetch(path: string, init?: RequestInit): Promise<unknown> {
	let res: Response
	try {
		res = await fetch(path, {
			...init,
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
		})
	} catch {
		throw new AuthRequestError(
			0,
			"network_error",
			"The server could not be reached.",
		)
	}
	const text = await res.text()
	let body: unknown = null
	try {
		body = text ? JSON.parse(text) : null
	} catch {
		body = null
	}
	if (!res.ok) {
		const rec = isRecord(body) ? body : {}
		const code = typeof rec.code === "string" ? rec.code : `http_${res.status}`
		const message =
			res.status === 429
				? "Too many attempts. Wait a few minutes and try again."
				: res.status === 503
					? "Sign-in is not available on this server yet."
					: typeof rec.message === "string"
						? rec.message
						: "The request failed."
		throw new AuthRequestError(res.status, code, message)
	}
	return body
}

const post = (path: string, body: unknown) =>
	authFetch(path, { method: "POST", body: JSON.stringify(body) })

/**
 * The signed-in identity; null when the API says there is no valid session (401); or
 * "unconfigured" when the local dev proxy has neither an API key nor a session cookie (its own
 * 503 `frontend_*` answer). The latter keeps the shell's existing honest "auth needed" status
 * instead of pretending to be signed out; the API still enforces every request.
 */
export async function fetchSession(
	signal?: AbortSignal,
): Promise<SessionInfo | null | "unconfigured"> {
	try {
		const body = await authFetch("/v1/me", { signal })
		return isRecord(body) ? (body as unknown as SessionInfo) : null
	} catch (error) {
		if (error instanceof AuthRequestError) {
			if (error.status === 401) return null
			if (error.status === 503 && error.code.startsWith("frontend_"))
				return "unconfigured"
		}
		throw error
	}
}

export const signUp = (input: {
	name: string
	email: string
	password: string
}) =>
	post("/api/auth/sign-up/email", {
		...input,
		callbackURL: "/login?verified=1",
	})

export const signIn = (input: { email: string; password: string }) =>
	post("/api/auth/sign-in/email", input)

export const signOut = () => post("/api/auth/sign-out", {})

export const requestPasswordReset = (email: string) =>
	post("/api/auth/request-password-reset", {
		email,
		redirectTo: `${window.location.origin}/reset-password`,
	})

export const resetPassword = (input: { token: string; newPassword: string }) =>
	post("/api/auth/reset-password", input)

export const resendVerification = (email: string) =>
	post("/api/auth/send-verification-email", {
		email,
		callbackURL: "/login?verified=1",
	})
