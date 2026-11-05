import { defineConfig, devices } from "@playwright/test"
import { LIVE_CREDENTIALS_SKIP_MESSAGE, liveCredentials } from "./helpers/credentials"

/**
 * Read-mostly checks against the deployed FlexiPay web app.
 * Credentials: FP_QA_EMAIL + FP_QA_PASSWORD (suite skips if either is unset).
 * Base URL: FP_LIVE_URL (default https://my.getflexipay.app).
 *
 * No screenshots, video or traces: credentials must never land in artifacts.
 */
const baseURL = process.env.FP_LIVE_URL?.trim() || "https://my.getflexipay.app"

if (!liveCredentials().ready) {
	console.warn(`\n${LIVE_CREDENTIALS_SKIP_MESSAGE}\n`)
}

export default defineConfig({
	testDir: "./tests",
	fullyParallel: false,
	workers: 1,
	reporter: "list",
	forbidOnly: !!process.env.CI,
	retries: 0,
	timeout: 120_000,
	expect: { timeout: 90_000 },
	use: {
		...devices["Desktop Chrome"],
		baseURL,
		screenshot: "off",
		video: "off",
		trace: "off",
		actionTimeout: 60_000,
		navigationTimeout: 90_000,
	},
})
