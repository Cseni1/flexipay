import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv, type Plugin } from "vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import { apiProxyPlugin } from "./vite.proxy.ts"

/**
 * Injects the Solana Wallet Standard test harness only when explicitly enabled.
 * Never active for production builds unless FP_SOLANA_TEST_WALLET=1 is set (it must not be).
 */
function solanaTestWalletHarnessPlugin(enabled: boolean): Plugin {
	return {
		name: "fp-solana-test-wallet-harness",
		transformIndexHtml(html) {
			if (!enabled) return html
			return {
				html,
				tags: [
					{
						tag: "script",
						attrs: {
							type: "module",
							src: "/test-harness/devnetTestWallet.ts",
						},
						injectTo: "body",
					},
				],
			}
		},
	}
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
	// Vite's config runs in Node. FP_API_KEY is read here only for the local same-origin
	// proxy; it is never put in `define`, `envPrefix` or any browser-visible value.
	const env = loadEnv(mode, process.cwd(), "")
	const solanaTestWallet =
		mode !== "production" && process.env.FP_SOLANA_TEST_WALLET === "1"

	return {
		plugins: [
			react(),
			nodePolyfills({
				include: ["buffer"],
				globals: {
					Buffer: true,
				},
			}),
			apiProxyPlugin({
				target: env.FP_API_URL,
				apiKey: env.FP_API_KEY,
			}),
			solanaTestWalletHarnessPlugin(solanaTestWallet),
		],
		build: {
			target: "esnext",
		},
		define: {
			global: "window",
		},
		// PUBLIC_* for legacy public config; VITE_* for browser-safe partner keys
		// (e.g. Transak staging). FP_API_URL and FP_API_KEY stay server-side only.
		envPrefix: ["PUBLIC_", "VITE_"],
	}
})
