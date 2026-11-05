/** localStorage key for the last till merchant wallet + label (never the amount). */
export const TILL_MERCHANT_STORAGE_KEY = "flexipay.till.merchant"

export type TillMerchantMemory = {
	wallet: string
	label: string
}

const isMemory = (value: unknown): value is TillMerchantMemory => {
	if (value === null || typeof value !== "object") return false
	const row = value as Record<string, unknown>
	return typeof row.wallet === "string" && typeof row.label === "string"
}

/** Read last merchant; returns null if missing, invalid, or storage throws. */
export function loadTillMerchant(
	storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined"
		? null
		: localStorage,
): TillMerchantMemory | null {
	if (!storage) return null
	try {
		const raw = storage.getItem(TILL_MERCHANT_STORAGE_KEY)
		if (!raw) return null
		const parsed: unknown = JSON.parse(raw)
		if (!isMemory(parsed)) return null
		return { wallet: parsed.wallet, label: parsed.label }
	} catch {
		return null
	}
}

/** Persist merchant wallet + label; no-op if storage throws. Never store the amount. */
export function saveTillMerchant(
	memory: TillMerchantMemory,
	storage: Pick<Storage, "setItem"> | null = typeof localStorage === "undefined"
		? null
		: localStorage,
): void {
	if (!storage) return
	try {
		storage.setItem(
			TILL_MERCHANT_STORAGE_KEY,
			JSON.stringify({
				wallet: memory.wallet,
				label: memory.label,
			}),
		)
	} catch {
		/* storage blocked or full — page must keep working */
	}
}

/** Clear saved merchant; no-op if storage throws. */
export function clearTillMerchant(
	storage: Pick<Storage, "removeItem"> | null = typeof localStorage ===
	"undefined"
		? null
		: localStorage,
): void {
	if (!storage) return
	try {
		storage.removeItem(TILL_MERCHANT_STORAGE_KEY)
	} catch {
		/* storage blocked — ignore */
	}
}
