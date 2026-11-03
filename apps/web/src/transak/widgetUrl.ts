/** Staging hosted Transak widget (query-param URL for the public staging key). */
export const TRANSAK_STAGING_WIDGET_ORIGIN = "https://global-stg.transak.com"

export type TransakStagingWidgetParams = {
	apiKey: string
	walletAddress: string
}

/**
 * Build the Transak staging widget URL for buying USDC on Solana into `walletAddress`.
 * The staging API key is public partner config (never a secret).
 */
export function buildTransakStagingWidgetUrl(
	params: TransakStagingWidgetParams,
): string {
	const apiKey = params.apiKey.trim()
	const walletAddress = params.walletAddress.trim()
	if (!apiKey) throw new Error("Transak staging API key is required")
	if (!walletAddress) throw new Error("Wallet address is required")

	const url = new URL(TRANSAK_STAGING_WIDGET_ORIGIN)
	url.searchParams.set("apiKey", apiKey)
	url.searchParams.set("walletAddress", walletAddress)
	url.searchParams.set("network", "solana")
	url.searchParams.set("cryptoCurrencyCode", "USDC")
	url.searchParams.set("environment", "STAGING")
	url.searchParams.set("productsAvailed", "BUY")
	url.searchParams.set("disableWalletAddressForm", "true")
	return url.toString()
}

/** Read the public staging key from Vite env (empty / missing → undefined). */
export function readTransakStagingKey(env: {
	VITE_TRANSAK_STAGING_KEY?: string
}): string | undefined {
	const raw = env.VITE_TRANSAK_STAGING_KEY
	if (typeof raw !== "string") return undefined
	const trimmed = raw.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

export type AddFundsGate =
	| { status: "unconfigured" }
	| { status: "connect_first" }
	| { status: "ready"; url: string }

/** Decide what the Add funds panel should show. */
export function resolveAddFundsGate(
	apiKey: string | undefined,
	walletAddress: string | null | undefined,
): AddFundsGate {
	if (!apiKey?.trim()) return { status: "unconfigured" }
	const address = walletAddress?.trim() ?? ""
	if (!address) return { status: "connect_first" }
	return {
		status: "ready",
		url: buildTransakStagingWidgetUrl({
			apiKey: apiKey.trim(),
			walletAddress: address,
		}),
	}
}
