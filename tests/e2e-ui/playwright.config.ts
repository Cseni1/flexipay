import { defineConfig, devices } from "@playwright/test"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// UI flows for the FlexiPay web app (apps/web). CF6 adds the DF2 to DF5 browser flows.
const webDir = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../apps/web",
)
const port = 5180

export default defineConfig({
	testDir: "./tests",
	reporter: "list",
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${port}` },
	webServer: {
		command: `npx vite --port ${port} --strictPort`,
		cwd: webDir,
		url: `http://localhost:${port}`,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
		// Fixture tests must not inherit a real key. The proxy-config test relies on an
		// explicit missing FP_API_KEY and an unused upstream port.
		env: {
			...(process.env as Record<string, string>),
			FP_API_URL: "http://127.0.0.1:5199",
			FP_API_KEY: "",				// Public, non-secret values from the repo's FP_ config. Only these two are exposed to
				// the browser by vite.config.ts, and they enable the passkey option. The wallet kit
				// itself is replaced by a deterministic module fixture in the passkey specs, so no
				// RPC request leaves the test browser.
				FP_STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
				FP_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
				// The inherited wallet-kit scaffold still reads PUBLIC_STELLAR_*; keep its network
				// values public and stable for the existing pages.
				PUBLIC_STELLAR_NETWORK: "TESTNET",
				PUBLIC_STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
				PUBLIC_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
				PUBLIC_STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
		},
	},
})
