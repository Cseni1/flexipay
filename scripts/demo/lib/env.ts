import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

// Environment for lane-D scripts. Only names here; values are read at run time and never
// printed. FP_API_KEY is a sandbox key and is the one value that must not reach logs or
// evidence, so nothing in this package serialises the environment.

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url))

export type SettlementMode = "mock" | "stellar"

export interface DemoEnv {
	apiUrl: string
	apiKey: string
	settlement: SettlementMode
	openapiPath: string
	timeoutMs: number
	evidenceDir: string
	/** Address for a Stellar claim release; absent in mock mode, never committed. */
	cryptoAddress?: string
}

export interface EnvProblem {
	key: string
	problem: string
	owner: string
}

export interface EnvResult {
	env: DemoEnv | null
	problems: EnvProblem[]
}

const parseMode = (raw: string | undefined): SettlementMode | null => {
	const value = (raw ?? "mock").trim().toLowerCase()
	return value === "mock" || value === "stellar" ? value : null
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): EnvResult {
	const problems: EnvProblem[] = []
	const apiUrl = source.FP_API_URL?.trim()
	if (!apiUrl) {
		problems.push({
			key: "FP_API_URL",
			problem:
				"not set; the base URL of the integrated API, e.g. http://127.0.0.1:3000",
			owner: "Csaba (integration)",
		})
	}
	const apiKey = source.FP_API_KEY?.trim()
	if (!apiKey) {
		problems.push({
			key: "FP_API_KEY",
			problem: "not set; a sandbox API key for the Demo Platform organization",
			owner: "Csaba (integration)",
		})
	}
	const settlement = parseMode(source.FP_SETTLEMENT)
	if (settlement === null) {
		problems.push({
			key: "FP_SETTLEMENT",
			problem: `unknown value "${source.FP_SETTLEMENT}"; expected mock or stellar`,
			owner: "lane D",
		})
	}
	const timeoutMs = Number(source.FP_HTTP_TIMEOUT_MS ?? 15_000)
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
		problems.push({
			key: "FP_HTTP_TIMEOUT_MS",
			problem: "must be between 1000 and 120000",
			owner: "lane D",
		})
	}
	if (problems.length > 0) return { env: null, problems }

	return {
		problems: [],
		env: {
			apiUrl: apiUrl!.replace(/\/+$/, ""),
			apiKey: apiKey!,
			settlement: settlement!,
			openapiPath: resolve(
				REPO_ROOT,
				source.FP_OPENAPI_PATH?.trim() || "apps/api/openapi.json",
			),
			timeoutMs,
			evidenceDir: resolve(
				REPO_ROOT,
				source.FP_EVIDENCE_DIR?.trim() || "scripts/demo/evidence",
			),
			...(source.FP_DEMO_CRYPTO_ADDRESS?.trim()
				? { cryptoAddress: source.FP_DEMO_CRYPTO_ADDRESS.trim() }
				: {}),
		},
	}
}

/** A claim token or account identifier must never be printed or stored in clear. */
export const maskValue = (value: string): string =>
	value.length <= 8 ? "***" : `${value.slice(0, 4)}…${value.slice(-4)}`

/** Claim tokens are path segments; print the route shape instead of the token. */
export const maskPath = (path: string): string =>
	path.replace(/\/v1\/claims\/([^/?#]+)/g, "/v1/claims/{token}")

export const maskAddress = (address: string): string => {
	if (address.length <= 10) return "***"
	return `${address.slice(0, 5)}…${address.slice(-4)}`
}
