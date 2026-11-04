import { readCrossmintClientKey } from "../onramp/orders"

/** Crossmint wallets-sdk only exposes chain `"solana"` (staging key selects test env). */
export const FLEXIPAY_WALLET_CHAIN = "solana" as const

/**
 * Auto-create / load a Solana embedded wallet after Crossmint email login.
 * Recovery is email OTP — no FlexiPay server JWT for this path.
 */
export const FLEXIPAY_WALLET_CREATE_ON_LOGIN = {
	chain: FLEXIPAY_WALLET_CHAIN,
	recoveryMethods: [{ type: "email" as const }],
}

export { readCrossmintClientKey }

export function isFlexiPayWalletConfigured(env: {
	VITE_CROSSMINT_CLIENT_KEY?: string
}): boolean {
	return Boolean(readCrossmintClientKey(env))
}
