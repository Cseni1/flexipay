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
			FP_API_KEY: "",
		},
	},
})
