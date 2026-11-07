/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_TRANSAK_STAGING_KEY?: string
	readonly VITE_CROSSMINT_CLIENT_KEY?: string
	/** Privy App ID for the FlexiPay embedded wallet (browser-safe). */
	readonly VITE_PRIVY_APP_ID?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}
