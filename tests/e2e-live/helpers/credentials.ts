/**
 * Live QA credentials from the environment only.
 * Never log, assert, or write these values into files or artifacts.
 */
export type LiveCredentials = {
	email: string
	password: string
	ready: boolean
}

export function liveCredentials(): LiveCredentials {
	const email = process.env.FP_QA_EMAIL?.trim() ?? ""
	const password = process.env.FP_QA_PASSWORD?.trim() ?? ""
	return {
		email,
		password,
		ready: email.length > 0 && password.length > 0,
	}
}

export const LIVE_CREDENTIALS_SKIP_MESSAGE =
	"Skipping live suite: set FP_QA_EMAIL and FP_QA_PASSWORD (never commit them)."
