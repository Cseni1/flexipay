import { defineConfig, devices } from "@playwright/test"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// UI flows for the FlexiPay web app (apps/web).
const webDir = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../apps/web",
)
const port = Number(process.env.E2E_PORT ?? 5180)

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
			FP_API_KEY: "",
			// Opt-in Solana Wallet Standard harness (apps/web/test-harness only; not in src/).
			FP_SOLANA_TEST_WALLET: "1",
			// Dummy Privy App ID so the FlexiPay wallet card renders (Privy SDK stubbed below).
			VITE_PRIVY_APP_ID: "privy_e2e_dummy_app",
			// Stub @privy-io/react-auth so e2e never calls Privy.
			FP_PRIVY_SDK_STUB: "1",
		},
	},
})
