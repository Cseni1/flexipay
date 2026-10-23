import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { REPO_ROOT } from "./lib/env.ts"

// Runs every flow in one settlement mode: mock by default, Stellar with --stellar. Each child
// prints its own route/legs/result; this wrapper only aggregates the exit codes. BLOCKED (2)
// never becomes PASS.

interface Run {
	id: string
	script: string
	args: string[]
}

const mode = process.argv.includes("--stellar") ? "stellar" : "mock"
const runs: Run[] = [
	{ id: "DF1", script: "df1-batch.ts", args: [] },
	{ id: "DF2", script: "df2-one-off.ts", args: [] },
	{ id: "DF3", script: "df3-claim.ts", args: ["--mode", mode] },
	{ id: "DF4", script: "df4-failure.ts", args: [] },
	{ id: "DF5", script: "df5-za-company.ts", args: [] },
]

const results: {
	id: string
	mode: string
	status: string
	code: number | null
}[] = []

for (const run of runs) {
	console.log(`\n=== ${run.id} (${mode}) ===`)
	const child = spawnSync(
		process.execPath,
		[join(REPO_ROOT, "scripts/demo", run.script), ...run.args],
		{
			cwd: REPO_ROOT,
			stdio: "inherit",
			timeout: 300_000,
			env: { ...process.env, FP_SETTLEMENT: mode },
		},
	)
	const code = child.status
	results.push({
		id: run.id,
		mode,
		status:
			code === 0
				? "PASS"
				: code === 2
					? "BLOCKED"
					: code === 1
						? "FAIL"
						: "ERROR",
		code,
	})
	if (code === null) console.error(`${run.id}: timed out after 300 s`)
}

console.log("\n=== summary ===")
for (const result of results) {
	console.log(
		`${result.id.padEnd(4)} ${result.mode.padEnd(8)} ${result.status}`,
	)
}

const codes = results.map((result) => result.code)
process.exit(codes.includes(1) ? 1 : codes.some((code) => code !== 0) ? 2 : 0)
