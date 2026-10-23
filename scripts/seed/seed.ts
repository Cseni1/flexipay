import { join } from "node:path"
import { readEnv, REPO_ROOT } from "../demo/lib/env.ts"
import { loadFixtures } from "../demo/lib/fixtures.ts"
import { HttpClient } from "../demo/lib/http.ts"
import { BlockedError, Flow, runFlow } from "../demo/lib/report.ts"
import { runSeed } from "./lib/runner.ts"

// D2 seed/reset CLI. Both commands go through the API: reset uses A0's empty
// SandboxResetRequestSchema; recipients and endpoints use the merged CCR-16/17 routes. No
// database write and no invented body.
//
//   node scripts/seed/seed.ts          reset, then create the neutral recipients and endpoints
//   node scripts/seed/seed.ts reset    only POST /v1/sandbox/reset
//
// Exit codes match the demo scripts: 0 PASS, 1 FAIL, 2 BLOCKED.

const command = process.argv[2] === "reset" ? "reset" : "seed"
const flow = new Flow({
	id: command === "reset" ? "seed-reset" : "seed",
	title:
		command === "reset"
			? "Reset the demo through /v1/sandbox/reset"
			: "Seed Demo Platform, Worker A to Worker D and their endpoints through the API",
	mode: "mock",
	evidenceDir: join(
		process.env.FP_EVIDENCE_DIR?.trim() ||
			join(REPO_ROOT, "scripts/demo/evidence"),
	),
})

const parsed = readEnv()
if (!parsed.env) {
	flow.finish(
		"BLOCKED",
		parsed.problems.map((problem) => ({
			what: `${problem.key} ${problem.problem}`,
			owner: problem.owner,
		})),
	)
}

const env = parsed.env!
const http = new HttpClient(env.apiUrl, env.apiKey, env.timeoutMs)

const result = await runFlow(flow, async () => {
	const health = await http.call("GET", "/healthz", { auth: false })
	if (health.status !== 200) {
		throw new BlockedError([
			{
				what: `API health check returned ${health.status}`,
				owner: "Csaba (integration)",
				detail: `GET ${env.apiUrl}/healthz`,
			},
		])
	}
	flow.check(`API health 200 at ${env.apiUrl}`)

	const fixtures = loadFixtures()
	flow.note(
		`fixtures  organization=${fixtures.organization}  workers=${fixtures.workers.length}`,
	)

	const outcome = await runSeed(http, fixtures, {
		command,
		hooks: { step: (name) => flow.check(name) },
	})

	flow.check(`reset HTTP ${outcome.resetStatus}`)
	if (command === "seed") {
		flow.check(`${outcome.recipients.length} recipients seeded`)
		flow.check(`${outcome.endpoints.length} endpoints seeded`)
	}
})

// runFlow exits; this keeps TypeScript aware that the promise never resolves.
void result
