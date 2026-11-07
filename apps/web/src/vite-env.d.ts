/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_TRANSAK_STAGING_KEY?: string
	/** Privy App ID for the FlexiPay embedded wallet (browser-safe). */
	readonly VITE_PRIVY_APP_ID?: string
	/** Sentry DSN for browser errors (optional; off when unset). */
	readonly VITE_SENTRY_DSN?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}
