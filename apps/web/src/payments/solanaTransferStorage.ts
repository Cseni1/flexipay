/** Per-payment Solana transfer signature so a sent tx is never forgotten. */

export type SolanaTransferMemory = {
	signature: string
	sentAt: string
}

export const solanaTransferStorageKey = (paymentId: string): string =>
	`flexipay.solana.transfer.${paymentId}`

const isMemory = (value: unknown): value is SolanaTransferMemory => {
	if (value === null || typeof value !== "object") return false
	const row = value as Record<string, unknown>
	return (
		typeof row.signature === "string" &&
		row.signature.length > 0 &&
		typeof row.sentAt === "string" &&
		row.sentAt.length > 0
	)
}

const defaultStorage = (): Pick<
	Storage,
	"getItem" | "setItem" | "removeItem"
> | null => (typeof localStorage === "undefined" ? null : localStorage)

/** Read a stored transfer; null if missing, invalid, or storage throws. */
export function loadSolanaTransfer(
	paymentId: string,
	storage: Pick<Storage, "getItem"> | null = defaultStorage(),
): SolanaTransferMemory | null {
	if (!storage || !paymentId) return null
	try {
		const raw = storage.getItem(solanaTransferStorageKey(paymentId))
		if (!raw) return null
		const parsed: unknown = JSON.parse(raw)
		if (!isMemory(parsed)) return null
		return { signature: parsed.signature, sentAt: parsed.sentAt }
	} catch {
		return null
	}
}

/** Persist signature + sentAt; no-op if storage throws. */
export function saveSolanaTransfer(
	paymentId: string,
	memory: SolanaTransferMemory,
	storage: Pick<Storage, "setItem"> | null = defaultStorage(),
): void {
	if (!storage || !paymentId) return
	try {
		storage.setItem(
			solanaTransferStorageKey(paymentId),
			JSON.stringify({
				signature: memory.signature,
				sentAt: memory.sentAt,
			}),
		)
	} catch {
		/* storage blocked or full — page must keep working */
	}
}

/** Clear stored transfer; no-op if storage throws. */
export function clearSolanaTransfer(
	paymentId: string,
	storage: Pick<Storage, "removeItem"> | null = defaultStorage(),
): void {
	if (!storage || !paymentId) return
	try {
		storage.removeItem(solanaTransferStorageKey(paymentId))
	} catch {
		/* storage blocked — ignore */
	}
}
