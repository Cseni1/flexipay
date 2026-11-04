import {
	preferredAssetFromConfig,
	type SolanaAsset,
	type SolanaAssetConfig,
} from "../solana/assets"
import { ApiError } from "./client"

export type SolanaConfig = {
	cluster: "devnet" | "testnet" | "mainnet-beta"
	/** CCR-26: configured settlement assets (optional on old APIs). */
	assets: SolanaAssetConfig[]
	usdcMint: string
	usdcDecimals: number
	explorerTxUrlTemplate: string
	/** Null when no public RPC is configured — never the server RPC. */
	publicRpcUrl: string | null
	label: string
}

export type SolanaIntent = {
	paymentId: string
	cluster: SolanaConfig["cluster"]
	/** CCR-26: always normalized (defaults to USDC when the API omits asset). */
	asset: SolanaAsset
	mint: string
	decimals: number
	/** Deprecated alias of mint/decimals; kept for older payloads. */
	usdcMint: string
	usdcDecimals: number
	amount: string
	recipient: string
	reference: string
	intentIssuedAt: string
	label: string
	explorerTxUrlTemplate: string
}

export type SolanaConfirmOk = {
	paymentId: string
	paymentStatus: "paid"
	signature: string
	explorerUrl: string
	verifiedAt: string
	cluster: SolanaConfig["cluster"]
}

const json = async (response: Response): Promise<unknown> => {
	const text = await response.text()
	if (!text) return null
	return JSON.parse(text) as unknown
}

const asRecord = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: {}

const parseAsset = (value: unknown): SolanaAsset | undefined => {
	if (value === "USDC" || value === "TGBP") return value
	return undefined
}

const parseAssetRow = (value: unknown): SolanaAssetConfig | null => {
	const row = asRecord(value)
	const asset = parseAsset(row.asset)
	const mint = typeof row.mint === "string" ? row.mint.trim() : ""
	const decimals =
		typeof row.decimals === "number" && Number.isFinite(row.decimals)
			? row.decimals
			: Number.NaN
	if (!asset || !mint || !Number.isFinite(decimals) || decimals < 0) return null
	return { asset, mint, decimals: Math.floor(decimals) }
}

/** Normalize GET /v1/solana/config; synthesize assets when the field is absent. */
export function parseSolanaConfig(payload: unknown): SolanaConfig {
	const raw = asRecord(payload)
	const usdcMint = typeof raw.usdcMint === "string" ? raw.usdcMint.trim() : ""
	const usdcDecimals =
		typeof raw.usdcDecimals === "number" && Number.isFinite(raw.usdcDecimals)
			? Math.floor(raw.usdcDecimals)
			: 0
	const parsedAssets = Array.isArray(raw.assets)
		? raw.assets
				.map(parseAssetRow)
				.filter((row): row is SolanaAssetConfig => row !== null)
		: []
	const assets =
		parsedAssets.length > 0
			? parsedAssets
			: usdcMint
				? [{ asset: "USDC" as const, mint: usdcMint, decimals: usdcDecimals }]
				: []

	return {
		cluster: (raw.cluster as SolanaConfig["cluster"]) ?? "devnet",
		assets,
		usdcMint,
		usdcDecimals,
		explorerTxUrlTemplate:
			typeof raw.explorerTxUrlTemplate === "string"
				? raw.explorerTxUrlTemplate
				: "",
		publicRpcUrl:
			typeof raw.publicRpcUrl === "string"
				? raw.publicRpcUrl
				: raw.publicRpcUrl === null
					? null
					: null,
		label: typeof raw.label === "string" ? raw.label : "Solana",
	}
}

/**
 * Normalize GET …/solana/intent.
 * Missing `asset` ⇒ USDC using usdcMint/usdcDecimals (legacy clients).
 */
export function parseSolanaIntent(payload: unknown): SolanaIntent {
	const raw = asRecord(payload)
	const usdcMint = typeof raw.usdcMint === "string" ? raw.usdcMint.trim() : ""
	const usdcDecimals =
		typeof raw.usdcDecimals === "number" && Number.isFinite(raw.usdcDecimals)
			? Math.floor(raw.usdcDecimals)
			: 0
	const asset = parseAsset(raw.asset) ?? "USDC"
	const mint =
		typeof raw.mint === "string" && raw.mint.trim() ? raw.mint.trim() : usdcMint
	const decimals =
		typeof raw.decimals === "number" && Number.isFinite(raw.decimals)
			? Math.floor(raw.decimals)
			: usdcDecimals

	return {
		paymentId: typeof raw.paymentId === "string" ? raw.paymentId : "",
		cluster: (raw.cluster as SolanaIntent["cluster"]) ?? "devnet",
		asset,
		mint,
		decimals,
		usdcMint: usdcMint || mint,
		usdcDecimals: usdcMint ? usdcDecimals : decimals,
		amount: typeof raw.amount === "string" ? raw.amount : "",
		recipient: typeof raw.recipient === "string" ? raw.recipient : "",
		reference: typeof raw.reference === "string" ? raw.reference : "",
		intentIssuedAt:
			typeof raw.intentIssuedAt === "string" ? raw.intentIssuedAt : "",
		label: typeof raw.label === "string" ? raw.label : "",
		explorerTxUrlTemplate:
			typeof raw.explorerTxUrlTemplate === "string"
				? raw.explorerTxUrlTemplate
				: "",
	}
}

export const getSolanaConfig = async (
	signal?: AbortSignal,
): Promise<SolanaConfig> => {
	const response = await fetch("/v1/solana/config", { signal })
	const payload = await json(response)
	if (!response.ok) {
		const record = (payload ?? {}) as { code?: string; message?: string }
		throw new ApiError(
			response.status,
			record.code ?? "http_error",
			record.message ?? "Solana config failed",
		)
	}
	return parseSolanaConfig(payload)
}

export const getSolanaIntent = async (
	paymentId: string,
	signal?: AbortSignal,
): Promise<SolanaIntent> => {
	const response = await fetch(
		`/v1/payments/${encodeURIComponent(paymentId)}/solana/intent`,
		{ signal },
	)
	const payload = await json(response)
	if (!response.ok) {
		const record = (payload ?? {}) as { code?: string; message?: string }
		throw new ApiError(
			response.status,
			record.code ?? "http_error",
			record.message ?? "Solana intent failed",
		)
	}
	return parseSolanaIntent(payload)
}

export const confirmSolanaTransfer = async (
	paymentId: string,
	signature: string,
	idempotencyKey: string,
	signal?: AbortSignal,
): Promise<SolanaConfirmOk> => {
	const response = await fetch(
		`/v1/payments/${encodeURIComponent(paymentId)}/solana/confirm`,
		{
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"Idempotency-Key": idempotencyKey,
			},
			body: JSON.stringify({ signature }),
			signal,
		},
	)
	const payload = await json(response)
	if (response.status === 202) {
		throw new ApiError(
			202,
			"pending",
			"Solana transaction is not confirmed yet; retry without sending again",
		)
	}
	if (!response.ok) {
		const record = (payload ?? {}) as { code?: string; message?: string }
		throw new ApiError(
			response.status,
			record.code ?? "http_error",
			record.message ?? "Solana confirm failed",
		)
	}
	const body = payload as SolanaConfirmOk
	if (body.paymentStatus !== "paid") {
		throw new ApiError(502, "internal_error", "Confirm response was not paid")
	}
	return body
}

export { preferredAssetFromConfig }
