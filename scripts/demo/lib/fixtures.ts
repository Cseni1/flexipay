import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { EndpointType, LegKind, RecipientKind } from "@flexipay/domain"
import { REPO_ROOT, type SettlementMode } from "./env.ts"
import type { MoneyView } from "./types.ts"

// Neutral fixtures live in scripts/seed/fixtures. They describe who is paid, with what amount and
// which documented route is expected; they contain no account number, address, key or token.

const FIXTURES = join(REPO_ROOT, "scripts/seed/fixtures")

export interface FixtureEndpoint {
	ref: string
	type: EndpointType
	country: string
	currency: string
	network?: "stellar"
	/** Key into the synthetic, in-memory details the A0 adapter supplies. Never a real account. */
	detailsRef: string
}

export interface FixtureWorker {
	ref: string
	name: string
	kind: RecipientKind
	country: string
	endpoints: FixtureEndpoint[]
}

export interface FlowRow {
	workerRef: string
	endpointRef: string
	send: MoneyView
}

export interface FlowSpec {
	profile: string
	workerRef: string
	endpointRef: string
	send: MoneyView
	delivery?: "direct" | "claim_link"
	rows?: FlowRow[]
}

export interface RouteExpectation {
	legs: LegKind[]
	collectRail?: string
	payoutRail?: string
	settleRail?: string
	domesticRail?: string
}

export interface Df1Expectation {
	us: RouteExpectation
	ph: RouteExpectation
	br: RouteExpectation
}

export interface Df4Expectation extends RouteExpectation {
	failCount: number
	payoutAttempts: number
}

export interface Fixtures {
	organization: string
	workers: FixtureWorker[]
	flows: Record<string, FlowSpec>
	expectations: {
		df1: Df1Expectation
		df2: RouteExpectation
		df3: RouteExpectation & { claimType: EndpointType }
		df4: Df4Expectation
		df5: RouteExpectation
	}
	cryptoDestination: { mock: string; stellarEnv: string }
}

interface WorkersFile {
	simulated?: boolean
	organization?: string
	workers?: FixtureWorker[]
}

interface FlowsFile {
	simulated?: boolean
	flows?: Record<string, FlowSpec>
	expectations?: Fixtures["expectations"]
	cryptoDestination?: Fixtures["cryptoDestination"]
}

const readJson = <T>(name: string): T =>
	JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T

export function loadFixtures(): Fixtures {
	const workers = readJson<WorkersFile>("workers.json")
	const flows = readJson<FlowsFile>("flows.json")
	if (workers.simulated !== true || flows.simulated !== true) {
		throw new Error("fixtures must carry simulated: true")
	}
	if (!workers.organization || !workers.workers?.length)
		throw new Error("workers.json has no workers")
	if (!flows.flows || !flows.expectations || !flows.cryptoDestination) {
		throw new Error("flows.json is incomplete")
	}
	return {
		organization: workers.organization,
		workers: workers.workers,
		flows: flows.flows,
		expectations: flows.expectations,
		cryptoDestination: flows.cryptoDestination,
	}
}

export function workerOf(fixtures: Fixtures, ref: string): FixtureWorker {
	const worker = fixtures.workers.find((w) => w.ref === ref)
	if (!worker) throw new Error(`fixture worker ${ref} not found`)
	return worker
}

export function endpointOf(
	worker: FixtureWorker,
	ref: string,
): FixtureEndpoint {
	const endpoint = worker.endpoints.find((e) => e.ref === ref)
	if (!endpoint)
		throw new Error(`fixture endpoint ${ref} not found on ${worker.ref}`)
	return endpoint
}

export function flowOf(fixtures: Fixtures, id: string): FlowSpec {
	const flow = fixtures.flows[id]
	if (!flow) throw new Error(`fixture flow ${id} not found`)
	return flow
}

/** Mock mode uses the labelled placeholder; stellar mode requires an address in the caller's env. */
export function destinationFor(
	fixtures: Fixtures,
	mode: SettlementMode,
	envAddress?: string,
): string {
	if (mode === "mock") return fixtures.cryptoDestination.mock
	if (!envAddress) {
		throw new Error(
			`${fixtures.cryptoDestination.stellarEnv} is required for DF3 on Stellar; no address is committed`,
		)
	}
	return envAddress
}
