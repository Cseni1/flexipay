import { ApiError } from "./client"

/** CCR-27 payment-request statuses returned by GET /v1/payment-requests/{id}. */
export type PaymentRequestStatus = "waiting" | "paid" | "expired"

export type PaymentRequestAmount = {
	amount: string
	currency: "TGBP"
}

/** Shared fields on create (201) and get responses. */
export type PaymentRequest = {
	id: string
	status: PaymentRequestStatus
	amount: PaymentRequestAmount
	merchantWallet: string
	reference: string
	solanaPayUrl: string
	expiresAt: string
	/** Present when status is paid. */
	signature?: string
	explorerUrl?: string
	/** Paying wallet from the verified transfer, when the API reports it. */
	payer?: string
}

export type CreatePaymentRequestBody = {
	/** GBP minor units as a decimal string (100 … 1_000_000). */
	amount: string
	merchantWallet: string
	label?: string
}

const asRecord = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: {}

const json = async (response: Response): Promise<unknown> => {
	const text = await response.text()
	if (!text) return null
	return JSON.parse(text) as unknown
}

const parseStatus = (value: unknown): PaymentRequestStatus | null => {
	if (value === "waiting" || value === "paid" || value === "expired")
		return value
	return null
}

const parseAmount = (value: unknown): PaymentRequestAmount | null => {
	const row = asRecord(value)
	if (typeof row.amount !== "string" || !/^\d+$/.test(row.amount)) return null
	if (row.currency !== "TGBP") return null
	return { amount: row.amount, currency: "TGBP" }
}

/** Normalize POST/GET payment-request payloads from the CCR-27 contract. */
export function parsePaymentRequest(payload: unknown): PaymentRequest {
	const raw = asRecord(payload)
	const status = parseStatus(raw.status)
	const amount = parseAmount(raw.amount)
	const id = typeof raw.id === "string" ? raw.id.trim() : ""
	const merchantWallet =
		typeof raw.merchantWallet === "string" ? raw.merchantWallet.trim() : ""
	const reference =
		typeof raw.reference === "string" ? raw.reference.trim() : ""
	const solanaPayUrl =
		typeof raw.solanaPayUrl === "string" ? raw.solanaPayUrl.trim() : ""
	const expiresAt =
		typeof raw.expiresAt === "string" ? raw.expiresAt.trim() : ""
	if (
		!status ||
		!amount ||
		!id ||
		!merchantWallet ||
		!reference ||
		!solanaPayUrl ||
		!expiresAt
	) {
		throw new ApiError(
			502,
			"invalid_response",
			"Payment request response did not match the contract.",
		)
	}
	const signature =
		typeof raw.signature === "string" && raw.signature.trim()
			? raw.signature.trim()
			: undefined
	const explorerUrl =
		typeof raw.explorerUrl === "string" && raw.explorerUrl.trim()
			? raw.explorerUrl.trim()
			: undefined
	const payer =
		typeof raw.payer === "string" && raw.payer.trim()
			? raw.payer.trim()
			: undefined
	return {
		id,
		status,
		amount,
		merchantWallet,
		reference,
		solanaPayUrl,
		expiresAt,
		...(signature ? { signature } : {}),
		...(explorerUrl ? { explorerUrl } : {}),
		...(payer ? { payer } : {}),
	}
}

const throwApiError = (
	response: Response,
	payload: unknown,
	fallback: string,
) => {
	const record = asRecord(payload)
	throw new ApiError(
		response.status,
		typeof record.code === "string" ? record.code : "http_error",
		typeof record.message === "string" ? record.message : fallback,
	)
}

export const createPaymentRequest = async (
	body: CreatePaymentRequestBody,
	signal?: AbortSignal,
): Promise<PaymentRequest> => {
	const response = await fetch("/v1/payment-requests", {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal,
	})
	const payload = await json(response)
	if (!response.ok) {
		throwApiError(response, payload, "Could not create the payment request.")
	}
	return parsePaymentRequest(payload)
}

export const getPaymentRequest = async (
	id: string,
	signal?: AbortSignal,
): Promise<PaymentRequest> => {
	const response = await fetch(
		`/v1/payment-requests/${encodeURIComponent(id)}`,
		{
			headers: { Accept: "application/json" },
			signal,
		},
	)
	const payload = await json(response)
	if (!response.ok) {
		throwApiError(response, payload, "Could not load the payment request.")
	}
	return parsePaymentRequest(payload)
}
