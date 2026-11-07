import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv, type Plugin } from "vite"
import { apiProxyPlugin } from "./vite.proxy.ts"

const rootDir = dirname(fileURLToPath(import.meta.url))
const bufferShim = resolve(rootDir, "src/buffer-shim.ts")

/**
 * Injects Buffer for Solana / wallet deps without vite-plugin-node-polyfills.
 * That plugin's trailing-slash shim aliases break Vite 8 + Rolldown when
 * Crossmint is in the graph.
 *
 * Uses rolldown/rollup `inject` (free-identifier only) plus an early HTML
 * module so `globalThis.Buffer` exists before the app graph runs.
 */
function bufferPolyfillPlugin(): Plugin {
	const inject = {
		Buffer: [bufferShim, "Buffer"] as [string, string],
	}

	return {
		name: "fp-buffer-polyfill",
		config() {
			return {
				define: {
					global: "globalThis",
				},
				optimizeDeps: {
					include: ["buffer"],
					rolldownOptions: {
						transform: {
							inject,
						},
					},
				},
				build: {
					rollupOptions: {
						transform: {
							inject,
						},
					},
				},
			}
		},
		transformIndexHtml() {
			return [
				{
					tag: "script",
					attrs: {
						type: "module",
						src: "/src/buffer-shim.ts",
					},
					injectTo: "head-prepend",
				},
			]
		},
	}
}

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
	const crossmintSdkStub =
		mode !== "production" && process.env.FP_CROSSMINT_SDK_STUB === "1"
	const privySdkStub =
		mode !== "production" && process.env.FP_PRIVY_SDK_STUB === "1"

	return {
		plugins: [
			react(),
			bufferPolyfillPlugin(),
			apiProxyPlugin({
				target: env.FP_API_URL,
				apiKey: env.FP_API_KEY,
			}),
			solanaTestWalletHarnessPlugin(solanaTestWallet),
		],
		resolve: {
			alias: [
				...(crossmintSdkStub
					? [
							{
								find: "@crossmint/client-sdk-react-ui",
								replacement: resolve(
									rootDir,
									"src/components/payFrom/crossmintSdk.stub.tsx",
								),
							},
						]
					: []),
				// Playwright only: Privy SDK and wallet balances without network or keys.
				...(privySdkStub
					? [
							{
								find: /^@privy-io\/react-auth(\/solana)?$/,
								replacement: resolve(
									rootDir,
									"src/flexipayWallet/privySdk.stub.tsx",
								),
							},
							{
								find: /^\.\/balances$/,
								replacement: resolve(
									rootDir,
									"src/flexipayWallet/balances.stub.ts",
								),
							},
						]
					: []),
			],
		},
		build: {
			target: "esnext",
		},
		// PUBLIC_* for legacy public config; VITE_* for browser-safe partner keys
		// (e.g. Transak staging). FP_API_URL and FP_API_KEY stay server-side only.
		envPrefix: ["PUBLIC_", "VITE_"],
	}
})
