import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import wasm from "vite-plugin-wasm"

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
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
		],
		build: {
			target: "esnext",
		},
		optimizeDeps: {
			exclude: ["@stellar/stellar-xdr-json"],
		},
		define: {
			global: "window",
			// Vite's envPrefix is a prefix, not an exact name. Inject only the exact public API
			// base here so a longer FP_API_URL-name cannot enter the bundle.
			"import.meta.env.FP_API_URL": JSON.stringify(env.FP_API_URL ?? ""),
		},
		// PUBLIC_* values are public Stellar configuration. No other FP_ value is exposed.
		envPrefix: ["PUBLIC_"],
	}
})
