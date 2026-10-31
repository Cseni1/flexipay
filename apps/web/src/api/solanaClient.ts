import { ApiError } from "./client"

export type SolanaConfig = {
	cluster: "devnet" | "testnet" | "mainnet-beta"
	usdcMint: string
	usdcDecimals: number
	explorerTxUrlTemplate: string
	publicRpcUrl?: string
	label: string
}

export type SolanaIntent = {
	paymentId: string
	cluster: SolanaConfig["cluster"]
	usdcMint: string
	usdcDecimals: number
	amount: string
	recipient: string
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
	return payload as SolanaConfig
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
	return payload as SolanaIntent
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
