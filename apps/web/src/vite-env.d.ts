/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_TRANSAK_STAGING_KEY?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}
