import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { REPO_ROOT } from "./lib/env.ts"

// Runs every mock flow, plus DF3 on Stellar when --stellar is given. Each child prints its own
// route/legs/result; this wrapper only aggregates the exit codes. BLOCKED (2) never becomes PASS.

interface Run {
	id: string
	script: string
	args: string[]
}

const runs: Run[] = [
	{ id: "DF1", script: "df1-batch.ts", args: [] },
	{ id: "DF2", script: "df2-one-off.ts", args: [] },
	{ id: "DF3", script: "df3-claim.ts", args: ["--mode", "mock"] },
	{ id: "DF4", script: "df4-failure.ts", args: [] },
	{ id: "DF5", script: "df5-za-company.ts", args: [] },
]
if (process.argv.includes("--stellar")) {
	runs.push({ id: "DF3", script: "df3-claim.ts", args: ["--mode", "stellar"] })
}

const results: {
	id: string
	mode: string
	status: string
	code: number | null
}[] = []

for (const run of runs) {
	const mode = run.args.includes("stellar") ? "stellar" : "mock"
	console.log(`\n=== ${run.id} (${mode}) ===`)
	const child = spawnSync(
		process.execPath,
		[join(REPO_ROOT, "scripts/demo", run.script), ...run.args],
		{
			cwd: REPO_ROOT,
			stdio: "inherit",
			timeout: 180_000,
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
	if (code === null) console.error(`${run.id}: timed out after 180 s`)
}

console.log("\n=== summary ===")
for (const result of results) {
	console.log(
		`${result.id.padEnd(4)} ${result.mode.padEnd(8)} ${result.status}`,
	)
}

const codes = results.map((result) => result.code)
process.exit(codes.includes(1) ? 1 : codes.some((code) => code !== 0) ? 2 : 0)
