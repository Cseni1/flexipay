import { config } from "@theahaco/ts-config/eslint"
import { globalIgnores } from "eslint/config"
import globals from "globals"

/** @type {import("eslint").Linter.Config[]} */
export default [
	// test-harness is opt-in via FP_SOLANA_TEST_WALLET=1 and is not part of the app tsconfig.
	globalIgnores(["dist", "test-harness/**"]),
	...config,
	{
		files: ["**/*.{ts,tsx}"],
		languageOptions: {
			ecmaVersion: 2020,
			globals: globals.browser,
			parserOptions: {
				tsconfigRoot: import.meta.dirname,
			},
		},
	},
	{
		// Vite config, proxy and its Node tests run outside the browser.
		files: ["vite.config.ts", "vite.proxy*.ts"],
		languageOptions: { globals: globals.node },
	},
]
