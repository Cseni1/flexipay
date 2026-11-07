import { ApiError } from "../api/client"

const PREPARE_FAILED =
	"Payment could not be prepared. Try again or contact support."

const WRONG_CLUSTER =
	"This wallet is on the wrong Solana network. Switch Phantom or Solflare to Devnet and reconnect."

const NO_SOL_FEES =
	"This wallet has no devnet SOL for network fees. Request devnet SOL from a faucet, then try again."

const INSUFFICIENT_USDC =
	"This wallet does not have enough of the required token for this payment. Top up the matching Solana test token (USDC or tGBP) and try again."

const USER_REJECTED =
	"You rejected the transaction in the wallet. Nothing was sent — you can try again."

const EXPIRED =
	"This claim or quote has expired. Create a new payment or open a fresh claim link."

const FALLBACK =
	"The Solana payment could not be completed. Check your wallet and try again."

const looksLikeJson = (text: string): boolean => {
	const trimmed = text.trim()
	return (
		(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
		(trimmed.startsWith("[") && trimmed.endsWith("]"))
	)
}

const asText = (cause: unknown): string => {
	if (cause instanceof ApiError) {
		return [cause.code, cause.message, ...cause.reasons].join(" ")
	}
	if (cause instanceof Error) return cause.message
	if (typeof cause === "string") return cause
	return ""
}

/**
 * Map Solana pay / intent failures to Demo Day copy. Never returns raw JSON.
 */
export function friendlySolanaPayError(cause: unknown): string {
	if (cause instanceof ApiError) {
		if (
			cause.status >= 500 ||
			cause.code === "internal_error" ||
			cause.code.startsWith("http_5")
		) {
			return PREPARE_FAILED
		}
		const blob = `${cause.code} ${cause.message}`.toLowerCase()
		if (
			blob.includes("expired") ||
			blob.includes("expiry") ||
			cause.code === "expired" ||
			cause.code === "quote_expired" ||
			cause.code === "claim_expired"
		) {
			return EXPIRED
		}
	}

	const raw = asText(cause)
	const lower = raw.toLowerCase()

	if (
		lower.includes("reject") ||
		lower.includes("denied") ||
		lower.includes("user cancel") ||
		lower.includes("cancelled") ||
		lower.includes("canceled")
	) {
		return USER_REJECTED
	}

	if (
		lower.includes("wrong solana network") ||
		lower.includes("does not advertise solana:") ||
		lower.includes("not enabled for solana:") ||
		lower.includes("switch the wallet network") ||
		lower.includes("switch the active network") ||
		lower.includes("wrong cluster") ||
		lower.includes("cluster mismatch") ||
		(lower.includes("mainnet") && lower.includes("devnet"))
	) {
		return WRONG_CLUSTER
	}

	if (
		lower.includes("no devnet sol") ||
		lower.includes("insufficient sol") ||
		lower.includes("insufficient funds for rent") ||
		lower.includes("insufficient lamports") ||
		lower.includes("no sol for network fees") ||
		lower.includes("need devnet sol")
	) {
		return NO_SOL_FEES
	}

	if (
		lower.includes("insufficient usdc") ||
		lower.includes("insufficient tgbp") ||
		lower.includes("not enough usdc") ||
		lower.includes("not enough tgbp") ||
		lower.includes("insufficient token") ||
		lower.includes("insufficient funds") ||
		// Exactly error 0x1 (SPL Token insufficient funds), not 0x10, 0x11 (frozen account), …
		/custom program error: 0x1(?![0-9a-f])/.test(lower) ||
		/(^|[^0-9a-fx])0x1(?![0-9a-f])/.test(lower)
	) {
		return INSUFFICIENT_USDC
	}

	if (
		lower.includes("expired") ||
		lower.includes("expiry") ||
		lower.includes("no longer valid")
	) {
		return EXPIRED
	}

	if (!raw || looksLikeJson(raw) || (raw.includes("{") && raw.includes("}"))) {
		return FALLBACK
	}

	return FALLBACK
}

export const SOLANA_PAY_ERROR_COPY = {
	PREPARE_FAILED,
	WRONG_CLUSTER,
	NO_SOL_FEES,
	INSUFFICIENT_USDC,
	USER_REJECTED,
	EXPIRED,
	FALLBACK,
} as const
