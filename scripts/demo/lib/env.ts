import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join, resolve } from "node:path"

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
	/** Worker A's published testnet address (FP_RECIPIENT_A_ADDRESS), never a secret. */
	recipientAddress?: string
	/** Public testnet RPC used to verify a Stellar release; no key needed. */
	stellarRpcUrl?: string
	stellarNetworkPassphrase?: string
	/** Public payout_vault contract id (FP_PAYOUT_VAULT_ID), never a key. */
	payoutVaultId?: string
}

/**
 * The deployed vault's public identity and fee, from the existing testnet evidence file
 * (`scripts/testnet/testnet-ids.env`, written by setup.sh and also used by the API). Lane D does
 * not take a fee rate from its own environment: a caller-supplied rate could make a wrong quote
 * pass. The evidence is tied to one vault id, so it is only valid for that deployment.
 */
export const TESTNET_IDS_PATH = join(
	REPO_ROOT,
	"scripts/testnet/testnet-ids.env",
)

export interface VaultEvidence {
	vaultId: string
	feeBps: number
	source: string
}

export type VaultEvidenceResult =
	{ ok: true; evidence: VaultEvidence } | { ok: false; problem: string }

export function readVaultEvidence(
	path = TESTNET_IDS_PATH,
): VaultEvidenceResult {
	if (!existsSync(path)) {
		return {
			ok: false,
			problem: `missing public testnet evidence at ${path}`,
		}
	}
	const text = readFileSync(path, "utf8")
	const read = (key: string): string | undefined => {
		const match = new RegExp(
			`^\\s*${key}\\s*=\\s*"?([^"\\n]+)"?\\s*$`,
			"m",
		).exec(text)
		return match?.[1]?.trim()
	}
	const vaultId = read("FP_PAYOUT_VAULT_ID")
	if (!vaultId) {
		return { ok: false, problem: `${path} has no FP_PAYOUT_VAULT_ID` }
	}
	const rawFee = read("FP_VAULT_FEE_BPS")
	const feeBps = rawFee === undefined ? Number.NaN : Number(rawFee)
	if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) {
		return {
			ok: false,
			problem: `${path} has no FP_VAULT_FEE_BPS in 0..1000`,
		}
	}
	return { ok: true, evidence: { vaultId, feeBps, source: path } }
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
			...(source.FP_RECIPIENT_A_ADDRESS?.trim()
				? { recipientAddress: source.FP_RECIPIENT_A_ADDRESS.trim() }
				: {}),
			...(source.FP_STELLAR_RPC_URL?.trim()
				? { stellarRpcUrl: source.FP_STELLAR_RPC_URL.trim() }
				: {}),
			...(source.FP_STELLAR_NETWORK_PASSPHRASE?.trim()
				? {
						stellarNetworkPassphrase:
							source.FP_STELLAR_NETWORK_PASSPHRASE.trim(),
					}
				: {}),
			...(source.FP_PAYOUT_VAULT_ID?.trim()
				? { payoutVaultId: source.FP_PAYOUT_VAULT_ID.trim() }
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
