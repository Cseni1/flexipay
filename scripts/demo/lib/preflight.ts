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

export interface RouteProbe {
	/** No route matched the path: only the API's catch-all 404 answered. */
	missing: RouteNeed[]
	/** The path matches a route, but its OPTIONS Allow header omits the needed method. */
	methodMismatches: { need: RouteNeed; allow: string[] }[]
}

const parseAllow = (response: Response): string[] =>
	(response.headers.get("allow") ?? "")
		.split(",")
		.map((method) => method.trim().toUpperCase())
		.filter(Boolean)

async function bodyCode(response: Response): Promise<string | undefined> {
	try {
		const raw = await response.text()
		if (raw.length === 0) return undefined
		const body: unknown = JSON.parse(raw)
		if (typeof body !== "object" || body === null) return undefined
		const code = (body as { code?: unknown }).code
		return typeof code === "string" ? code : undefined
	} catch {
		return undefined
	}
}

const probeTimeout = (timeoutMs: number): number => Math.min(timeoutMs, 3_000)

/**
 * OpenAPI contains A0 stubs that CC3 has not mounted, so the inventory alone is not evidence a
 * route is served. Express adds a route's methods to the OPTIONS `Allow` header; the app's
 * catch-all answers an unmatched path with 404 {"code":"not_found"} and no Allow header.
 *
 * OPTIONS support by itself proves nothing (a proxy or a global handler can answer it), and an
 * auth, method or application error on a mounted route must not be reported as a missing route.
 * Only the catch-all shape counts as missing; a path that answers with Allow but omits the
 * needed method is reported separately, and anything else (401/403/405/5xx, an application-level
 * 404, or an OPTIONS answer without Allow) is treated as mounted so the run surfaces the real
 * defect instead of a false missing-route blocker.
 */
export async function probeRoutes(
	apiUrl: string,
	needs: readonly RouteNeed[],
	timeoutMs: number,
): Promise<RouteProbe> {
	const probe: RouteProbe = { missing: [], methodMismatches: [] }
	for (const need of needs) {
		const url = `${apiUrl}${routeProbePath(need.path)}`
		let response: Response
		try {
			response = await fetch(url, {
				method: "OPTIONS",
				signal: AbortSignal.timeout(probeTimeout(timeoutMs)),
			})
		} catch {
			// The health blocker already covers an unreachable API; do not duplicate it per route.
			continue
		}

		const allow = parseAllow(response)
		const code = await bodyCode(response)
		if (response.status === 404 && allow.length === 0 && code === "not_found") {
			// The catch-all shape: no route matched, and Express would have listed one in Allow otherwise.
			probe.missing.push(need)
			continue
		}
		if (allow.length > 0) {
			if (!allow.includes(need.method)) {
				probe.methodMismatches.push({ need, allow })
			}
			continue
		}
		// No Allow header: OPTIONS may have been answered by a proxy or a global handler. For a
		// GET route, a real GET without auth is side-effect free and shows which handler answered.
		if (need.method === "GET") {
			let fallback: Response
			try {
				fallback = await fetch(url, {
					method: "GET",
					headers: { accept: "application/json" },
					signal: AbortSignal.timeout(probeTimeout(timeoutMs)),
				})
			} catch {
				continue
			}
			const fallbackCode = await bodyCode(fallback)
			if (
				fallback.status === 404 &&
				parseAllow(fallback).length === 0 &&
				fallbackCode === "not_found"
			) {
				probe.missing.push(need)
			}
		}
	}
	return probe
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
	const runtime = await probeRoutes(
		env.apiUrl,
		options.needs.filter((need) => !contractGaps.includes(need)),
		env.timeoutMs,
	)
	for (const gap of [...contractGaps, ...runtime.missing]) {
		blockers.push({
			what: `route not available: ${gap.method} ${gap.path}`,
			owner: "Csaba (CC3a/CC3b)",
			detail: gap.purpose,
		})
	}
	for (const mismatch of runtime.methodMismatches) {
		blockers.push({
			what: `route does not accept ${mismatch.need.method}: ${mismatch.need.path}`,
			owner: "Csaba (CC3a/CC3b)",
			detail: `OPTIONS allows ${mismatch.allow.join(", ")}; ${mismatch.need.purpose}`,
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
