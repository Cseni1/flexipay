/**
 * Loads gitignored payer env and runs the live TASK 02 proof.
 * Never prints FP_SOLANA_PAYER_SECRET.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

const dir = dirname(fileURLToPath(import.meta.url))
const envPath = join(dir, ".env.solana-payer")
const raw = readFileSync(envPath, "utf8")
for (const line of raw.split(/\r?\n/)) {
	const m = /^FP_SOLANA_PAYER_SECRET=(.*)$/.exec(line.trim())
	if (!m) continue
	let value = m[1]
	// File stores: FP_SOLANA_PAYER_SECRET="<json-stringified-array>"
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = JSON.parse(value)
	}
	process.env.FP_SOLANA_PAYER_SECRET = value
}

if (!process.env.FP_SOLANA_PAYER_SECRET) {
	console.error("Missing FP_SOLANA_PAYER_SECRET in scripts/demo/.env.solana-payer")
	process.exit(1)
}

process.env.FP_SETTLEMENT = process.env.FP_SETTLEMENT ?? "mock"
process.env.FP_SOLANA_CLUSTER = "devnet"

const child = spawn(
	process.platform === "win32" ? "npx.cmd" : "npx",
	["--yes", "tsx", join(dir, "task02-solana-proof.ts")],
	{
		stdio: "inherit",
		env: process.env,
		cwd: join(dir, "../.."),
		shell: process.platform === "win32",
	},
)
child.on("exit", (code) => process.exit(code ?? 1))
