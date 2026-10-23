import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { REPO_ROOT, type DemoEnv, type SettlementMode } from "./env.ts"
import { NetworkFailure, HttpClient } from "./http.ts"
import type { Blocker } from "./report.ts"

// Prerequisites for a DF run. Everything missing becomes an explicit blocker with an owner:
// the scripts never guess a body or a field to work around an absent contract.

export interface RouteNeed {
	method: "GET" | "POST"
	path: string
	purpose: string
}

export interface ApiContract {
	paths: Record<string, Record<string, unknown>>
}

export const A0_DIR = join(REPO_ROOT, "packages/domain/src/api")
const STELLAR_DIR = join(REPO_ROOT, "packages/adapter-stellar/src")

export function loadContract(path: string): ApiContract | null {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as { paths?: unknown }
		if (typeof raw.paths !== "object" || raw.paths === null) return null
		return { paths: raw.paths as Record<string, Record<string, unknown>> }
	} catch {
		return null
	}
}

export const contractHas = (contract: ApiContract, need: RouteNeed): boolean =>
	Object.prototype.hasOwnProperty.call(
		contract.paths[need.path] ?? {},
		need.method.toLowerCase(),
	)

export function routeGaps(
	contract: ApiContract,
	needs: readonly RouteNeed[],
): RouteNeed[] {
	return needs.filter((need) => !contractHas(contract, need))
}

/** `/v1/payments/{id}` → `/v1/payments/probe`; params need a concrete segment for OPTIONS. */
export const routeProbePath = (path: string): string =>
	path.replace(/\{[^}]+\}/g, "probe")

/**
 * OpenAPI contains A0 stubs that CC3 has not mounted. Express answers OPTIONS for a mounted
 * route (200) and the catch-all 404 for an absent one, so this distinguishes a real route from a
 * published stub without sending a mutation or requiring a valid key.
 */
export async function runtimeRouteGaps(
	apiUrl: string,
	needs: readonly RouteNeed[],
	timeoutMs: number,
): Promise<RouteNeed[]> {
	const gaps: RouteNeed[] = []
	for (const need of needs) {
		try {
			const response = await fetch(`${apiUrl}${routeProbePath(need.path)}`, {
				method: "OPTIONS",
				signal: AbortSignal.timeout(Math.min(timeoutMs, 3_000)),
			})
			if (response.status === 404) gaps.push(need)
		} catch {
			// The health blocker already covers an unreachable API; do not duplicate it per route.
		}
	}
	return gaps
}

const A0_SCHEMAS = [
	"quote request and response (POST /v1/quotes)",
	"payment create and read (POST/GET /v1/payments, GET /v1/payments/{id})",
	"fund and cancel bodies (POST /v1/payments/{id}/fund, /cancel)",
	"batch create and read (POST /v1/batches, GET /v1/batches/{id})",
	"claim view and accept (GET /v1/claims/{token}, POST /v1/claims/{token}/accept)",
	"event list (GET /v1/events)",
	"sandbox controls (fail-next, advance-time, reset)",
]

export interface PreflightOptions {
	needs: readonly RouteNeed[]
	mode: SettlementMode
}

export async function preflight(
	env: DemoEnv,
	options: PreflightOptions,
): Promise<Blocker[]> {
	const blockers: Blocker[] = []

	const client = new HttpClient(env.apiUrl, env.apiKey, env.timeoutMs)
	try {
		const health = await client.call("GET", "/healthz", { auth: false })
		if (health.status !== 200) {
			blockers.push({
				what: `API health check returned ${health.status}`,
				owner: "Csaba (integration)",
				detail: `GET ${env.apiUrl}/healthz`,
			})
		}
	} catch (error) {
		if (!(error instanceof NetworkFailure)) throw error
		blockers.push({
			what: `integrated API is not reachable at ${env.apiUrl}`,
			owner: "Csaba (integration)",
			detail: error.message,
		})
	}

	const contract = loadContract(env.openapiPath)
	const contractGaps: RouteNeed[] = []
	if (!contract) {
		blockers.push({
			what: "OpenAPI route inventory is missing or unreadable",
			owner: "Csaba (A0/CC3)",
			detail: `expected ${env.openapiPath}; regenerate with npm run openapi --workspace @flexipay/api`,
		})
	} else {
		contractGaps.push(...routeGaps(contract, options.needs))
	}
	const runtimeGaps = await runtimeRouteGaps(
		env.apiUrl,
		options.needs.filter((need) => !contractGaps.includes(need)),
		env.timeoutMs,
	)
	for (const gap of [...contractGaps, ...runtimeGaps]) {
		blockers.push({
			what: `route not available: ${gap.method} ${gap.path}`,
			owner: "Csaba (CC3a/CC3b)",
			detail: gap.purpose,
		})
	}

	if (!existsSync(A0_DIR)) {
		blockers.push({
			what: "A0 API contracts are absent (packages/domain/src/api)",
			owner: "Csaba (A0)",
			detail: A0_SCHEMAS.join("; "),
		})
	}

	if (options.mode === "stellar" && !existsSync(STELLAR_DIR)) {
		blockers.push({
			what: "Stellar settlement adapter is absent (packages/adapter-stellar)",
			owner: "Cursor / Csenge (SC2)",
			detail:
				"DF3 on Stellar needs the adapter exported and wired into the API by FP_SETTLEMENT",
		})
	}

	return blockers
}
