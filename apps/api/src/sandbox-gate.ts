// Sandbox controls (/v1/sandbox/*: fail-next, provider-health, advance-time, reset) change
// simulated provider behaviour, move the API clock and wipe an organization's data. They exist
// for local development and tests only and must never be reachable on a hosted API.
//
// Fail-closed: disabled unless FP_SANDBOX is exactly "1". Even then NODE_ENV=production forces
// them off, so a copied local .env cannot expose them on a server that sets NODE_ENV (whether a
// given host sets NODE_ENV is NOT assumed: the primary protection is that FP_SANDBOX is never
// set on a hosted API). Customer sessions never authorise these routes either way: they are
// `auth: "api_key"` only (see routes.ts).

export function sandboxEnabledFromEnv(env: Record<string, string | undefined>): boolean {
	return env.FP_SANDBOX === "1" && env.NODE_ENV !== "production";
}
