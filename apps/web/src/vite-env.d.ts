/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly FP_API_URL?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}
