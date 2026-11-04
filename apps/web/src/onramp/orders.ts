/** USD whole-number bounds for Crossmint card checkout (staging). */
export const ONRAMP_AMOUNT_USD_MIN = 5
export const ONRAMP_AMOUNT_USD_MAX = 100

export type CreateOnrampOrderBody = {
	walletAddress: string
	amountUsd: string
}

export type OnrampOrderResponse = {
	orderId: string
	clientSecret: string
}

/**
 * Validate a USD amount string as a whole number in [5, 100].
 * Returns a normalized decimal string (no leading zeros) on success.
 */
export function parseOnrampAmountUsd(
	raw: string,
): { ok: true; amountUsd: string } | { ok: false; error: string } {
	const trimmed = raw.trim()
	if (!/^\d+$/.test(trimmed)) {
		return {
			ok: false,
			error: "Enter a whole-dollar amount between 5 and 100 USD.",
		}
	}
	const value = Number.parseInt(trimmed, 10)
	if (
		!Number.isFinite(value) ||
		value < ONRAMP_AMOUNT_USD_MIN ||
		value > ONRAMP_AMOUNT_USD_MAX
	) {
		return {
			ok: false,
			error: `Amount must be a whole number from ${ONRAMP_AMOUNT_USD_MIN} to ${ONRAMP_AMOUNT_USD_MAX} USD.`,
		}
	}
	return { ok: true, amountUsd: String(value) }
}

/** Build the POST /v1/onramp/orders JSON body. */
export function buildCreateOnrampOrderBody(input: {
	walletAddress: string
	amountUsd: string | number
}): CreateOnrampOrderBody {
	const walletAddress = input.walletAddress.trim()
	if (!walletAddress) throw new Error("Wallet address is required")
	const parsed =
		typeof input.amountUsd === "number"
			? parseOnrampAmountUsd(String(input.amountUsd))
			: parseOnrampAmountUsd(input.amountUsd)
	if (!parsed.ok) throw new Error(parsed.error)
	return { walletAddress, amountUsd: parsed.amountUsd }
}

/** Read the public Crossmint client key from Vite env. */
export function readCrossmintClientKey(env: {
	VITE_CROSSMINT_CLIENT_KEY?: string
}): string | undefined {
	const raw = env.VITE_CROSSMINT_CLIENT_KEY
	if (typeof raw !== "string") return undefined
	const trimmed = raw.trim()
	return trimmed.length > 0 ? trimmed : undefined
}
