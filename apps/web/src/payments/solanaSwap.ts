import {
	type SolanaSwapConfirmResponse,
	type SolanaSwapResponse,
} from "@flexipay/web-lib/contract"

// CCR-49: helpers for the sender-wallet tGBP → USDC swap step.

export type SwapPreview = SolanaSwapResponse

/** Base units → human amount, trimmed to `dp` decimals (rounded down). */
export function formatUnits(amount: string, decimals: number, dp = 2): string {
	if (!/^\d+$/.test(amount)) return "0"
	const padded = amount.padStart(decimals + 1, "0")
	const whole = padded.slice(0, padded.length - decimals) || "0"
	const frac = decimals > 0 ? padded.slice(padded.length - decimals) : ""
	const shown = frac.slice(0, dp).padEnd(dp, "0")
	const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
	return dp > 0 ? `${grouped}.${shown}` : grouped
}

/**
 * Poll the swap confirm endpoint until Solana confirms it. A failed swap or a short balance
 * comes back as an API error and stops here; a swap still unseen after `timeoutMs` throws.
 */
export async function waitForSwap(
	check: () => Promise<SolanaSwapConfirmResponse>,
	opts: {
		intervalMs?: number
		timeoutMs?: number
		sleep?: (ms: number) => Promise<void>
	} = {},
): Promise<SolanaSwapConfirmResponse> {
	const interval = opts.intervalMs ?? 2_000
	const deadline = Date.now() + (opts.timeoutMs ?? 90_000)
	const sleep =
		opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
	for (;;) {
		const result = await check()
		if (result.status === "confirmed") return result
		if (Date.now() >= deadline) {
			throw new Error(
				"The swap has not landed on Solana yet. Check your wallet before trying again.",
			)
		}
		await sleep(interval)
	}
}
