import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import wasm from "vite-plugin-wasm"
import { apiProxyPlugin } from "./vite.proxy.ts"

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
	// Vite's config runs in Node. FP_API_KEY is read here only for the local same-origin
	// proxy; it is never put in `define`, `envPrefix` or any browser-visible value.
	const env = loadEnv(mode, process.cwd(), "")

	return {
		plugins: [
			react(),
			nodePolyfills({
				include: ["buffer"],
				globals: {
					Buffer: true,
				},
			}),
			wasm(),
			apiProxyPlugin({
				target: env.FP_API_URL,
				apiKey: env.FP_API_KEY,
			}),
		],
		build: {
			target: "esnext",
		},
		optimizeDeps: {
			exclude: ["@stellar/stellar-xdr-json"],
		},
		define: {
			global: "window",
		},
		// PUBLIC_* values are public Stellar configuration. FP_API_URL and FP_API_KEY stay
		// server-side; the clients call relative /v1 paths through the proxy.
		envPrefix: ["PUBLIC_"],
	}
})
