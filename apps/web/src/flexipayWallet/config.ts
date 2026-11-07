/**
 * FlexiPay wallet = Privy embedded Solana wallet (replaces Crossmint, which declined the
 * application on 7 Nov 2026). Email or passkey login; Privy never sees a seed phrase and
 * FlexiPay never holds keys.
 */
export const FLEXIPAY_WALLET_CHAIN = "solana:devnet" as const

/** Public Privy App ID from the Privy dashboard (browser-safe, not a secret). */
export function readPrivyAppId(env: { VITE_PRIVY_APP_ID?: string }): string {
	return env.VITE_PRIVY_APP_ID?.trim() ?? ""
}

export function isFlexiPayWalletConfigured(env: {
	VITE_PRIVY_APP_ID?: string
}): boolean {
	return Boolean(readPrivyAppId(env))
}
