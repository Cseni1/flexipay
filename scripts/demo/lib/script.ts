import { join } from "node:path"
import { loadDemoApi } from "./api.ts"
import { REPO_ROOT, readEnv, type DemoEnv, type SettlementMode } from "./env.ts"
import { loadFixtures, type Fixtures } from "./fixtures.ts"
import { preflight, type RouteNeed } from "./preflight.ts"
import { Flow, runFlow } from "./report.ts"
import type { DemoApi } from "./types.ts"

export interface FlowContext {
	api: DemoApi
	env: DemoEnv
	fixtures: Fixtures
	flow: Flow
}

export interface ExecuteOptions {
	id: string
	title: string
	needs: RouteNeed[]
	/** Overrides FP_SETTLEMENT for one script (DF3 runs both modes). */
	mode?: SettlementMode
}

/** Reads `--mode mock|stellar`, falling back to FP_SETTLEMENT. */
export function modeArg(
	argv: readonly string[],
	fallback: SettlementMode,
): SettlementMode {
	const inline = argv.find((arg) => arg.startsWith("--mode="))
	const index = argv.indexOf("--mode")
	const raw =
		inline?.slice("--mode=".length) ??
		(index >= 0 ? argv[index + 1] : undefined)
	if (raw === undefined) return fallback
	if (raw !== "mock" && raw !== "stellar") {
		throw new Error(`unknown --mode "${raw}"; expected mock or stellar`)
	}
	return raw
}

/**
 * Starts a DF run: environment, API health, route inventory, A0 contracts, then the flow body.
 * Anything missing ends the process as BLOCKED with an owner and an evidence file.
 */
export async function execute(
	options: ExecuteOptions,
	body: (context: FlowContext) => Promise<void>,
): Promise<never> {
	const parsed = readEnv()
	const mode = options.mode ?? parsed.env?.settlement ?? "mock"
	const flow = new Flow({
		id: options.id,
		title: options.title,
		mode,
		evidenceDir:
			parsed.env?.evidenceDir ?? join(REPO_ROOT, "scripts/demo/evidence"),
	})

	if (!parsed.env) {
		return flow.finish(
			"BLOCKED",
			parsed.problems.map((problem) => ({
				what: `${problem.key} ${problem.problem}`,
				owner: problem.owner,
			})),
		)
	}

	const blockers = await preflight(parsed.env, { needs: options.needs, mode })
	if (mode === "stellar") {
		if (!parsed.env.recipientAddress) {
			blockers.push({
				what: "FP_RECIPIENT_A_ADDRESS is not set for a Stellar claim release",
				owner: "caller / Csaba (integration)",
				detail:
					"the published Worker A testnet address; no address is committed to the repo",
			})
		}
		if (!parsed.env.stellarRpcUrl) {
			blockers.push({
				what: "FP_STELLAR_RPC_URL is not set, so a Stellar release cannot be verified",
				owner: "caller / Csaba (integration)",
				detail:
					"DF3 requires an RPC lookup of the release hash; a 64-hex string alone is not proof",
			})
		}
	}
	if (blockers.length > 0) return flow.finish("BLOCKED", blockers)

	const api = loadDemoApi(parsed.env)
	const fixtures = loadFixtures()
	return runFlow(flow, () => body({ api, env: parsed.env!, fixtures, flow }))
}
