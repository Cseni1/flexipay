import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { pathToFileURL } from "node:url"
import { REPO_ROOT } from "./lib/env.ts"

// Offline demo launcher (D2). It starts the existing development paths only:
//   npm run dev --workspace @flexipay/api   embedded Postgres + migrations + API
//   npm run dev --workspace @flexipay/web   Vite
// Settlement is forced to mock; every provider in config/ is simulated. No Docker, no second
// database, no queue and no new framework. The API command owns Postgres startup (Cursor owns
// that repair); this launcher never starts or migrates a database itself.
//
//   node scripts/demo/offline.ts               start, then seed when FP_API_KEY is set
//   node scripts/demo/offline.ts --no-seed     start only
//   node scripts/demo/offline.ts --print-plan  print the loopback plan without starting anything

export interface OfflineConfig {
	apiPort: number
	webPort: number
	seed: boolean
	apiTimeoutMs: number
	webTimeoutMs: number
}

export interface OfflinePlan {
	api: {
		url: string
		command: string
		args: string[]
		env: Record<string, string>
	}
	web: {
		url: string
		command: string
		args: string[]
		env: Record<string, string>
	}
	seed:
		| { enabled: true; command: string; args: string[]; apiUrl: string }
		| { enabled: false; reason: string }
	settlement: "mock"
	providers: "simulated"
}

const DEFAULT_API_PORT = 8788
const DEFAULT_WEB_PORT = 5173

const portOf = (
	raw: string | undefined,
	name: string,
	fallback: number,
): number => {
	const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw)
	if (!Number.isInteger(value) || value < 1 || value > 65_535) {
		throw new Error(
			`${name} must be an integer between 1 and 65535, got "${raw}"`,
		)
	}
	return value
}

const timeoutOf = (
	raw: string | undefined,
	name: string,
	fallback: number,
): number => {
	const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw)
	if (!Number.isFinite(value) || value < 5_000 || value > 600_000) {
		throw new Error(`${name} must be between 5000 and 600000 ms, got "${raw}"`)
	}
	return value
}

export function readOfflineConfig(
	source: NodeJS.ProcessEnv = process.env,
	argv: readonly string[] = process.argv.slice(2),
): OfflineConfig {
	const apiPort = portOf(source.FP_API_PORT, "FP_API_PORT", DEFAULT_API_PORT)
	const webPort = portOf(source.FP_WEB_PORT, "FP_WEB_PORT", DEFAULT_WEB_PORT)
	if (apiPort === webPort)
		throw new Error("FP_API_PORT and FP_WEB_PORT must differ")
	return {
		apiPort,
		webPort,
		seed: !argv.includes("--no-seed"),
		apiTimeoutMs: timeoutOf(
			source.FP_OFFLINE_API_TIMEOUT_MS,
			"FP_OFFLINE_API_TIMEOUT_MS",
			120_000,
		),
		webTimeoutMs: timeoutOf(
			source.FP_OFFLINE_WEB_TIMEOUT_MS,
			"FP_OFFLINE_WEB_TIMEOUT_MS",
			60_000,
		),
	}
}

/**
 * Pure plan used by --print-plan and the tests. It carries no secret: FP_API_KEY is never copied
 * into the plan, and the seed step only receives the public API URL plus the inherited environment
 * at spawn time.
 */
export function buildOfflinePlan(
	config: OfflineConfig,
	source: NodeJS.ProcessEnv = process.env,
): OfflinePlan {
	const apiUrl = `http://127.0.0.1:${config.apiPort}`
	const webUrl = `http://127.0.0.1:${config.webPort}`
	const hasKey = Boolean(source.FP_API_KEY?.trim())
	const seedPath = join(REPO_ROOT, "scripts/seed/seed.ts")
	return {
		api: {
			url: apiUrl,
			command: "npm",
			args: ["run", "dev", "--workspace", "@flexipay/api"],
			env: {
				PORT: String(config.apiPort),
				FP_SETTLEMENT: "mock",
				FP_CONFIG_DIR: join(REPO_ROOT, "config"),
			},
		},
		web: {
			url: webUrl,
			command: "npm",
			args: [
				"run",
				"dev",
				"--workspace",
				"@flexipay/web",
				"--",
				"--host",
				"127.0.0.1",
				"--port",
				String(config.webPort),
			],
			env: { BROWSER: "none" },
		},
		seed: config.seed
			? hasKey
				? { enabled: true, command: process.execPath, args: [seedPath], apiUrl }
				: {
						enabled: false,
						reason:
							"FP_API_KEY is not set; the API has no route that creates an organization or key yet (owner: integration)",
					}
			: { enabled: false, reason: "--no-seed was passed" },
		settlement: "mock",
		providers: "simulated",
	}
}

async function assertPortFree(port: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const server = createServer()
		server.once("error", (error: NodeJS.ErrnoException) => {
			reject(
				error.code === "EADDRINUSE"
					? new Error(
							`port ${port} is already in use; stop that process or set FP_API_PORT/FP_WEB_PORT`,
						)
					: error,
			)
		})
		server.listen(port, "127.0.0.1", () => server.close(() => resolve()))
	})
}

/** Polls a loopback URL until it answers with a 2xx. Never resolves early on a banner alone. */
export async function waitForHttp(
	url: string,
	timeoutMs: number,
	label: string,
): Promise<void> {
	const started = Date.now()
	let last = "no response"
	let nextProgress = 5_000
	while (Date.now() - started < timeoutMs) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(3_000) })
			if (response.status >= 200 && response.status < 300) {
				console.log(`ready  ${label}  ${url}  HTTP ${response.status}`)
				return
			}
			last = `HTTP ${response.status}`
		} catch (error) {
			last = error instanceof Error ? error.name : "unknown error"
		}
		const elapsed = Date.now() - started
		if (elapsed >= nextProgress) {
			console.log(
				`wait   ${label}  ${url}  ${last}  (${Math.round(elapsed / 1000)}s)`,
			)
			nextProgress += 5_000
		}
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
	throw new Error(
		`${label} did not become ready at ${url} within ${timeoutMs} ms (${last})`,
	)
}

interface Running {
	label: string
	child: ChildProcess
	log: string[]
}

function capture(running: Running): void {
	const keep = (line: string) => {
		if (line.trim() === "") return
		console.log(`${running.label.padEnd(3)} ${line}`)
		running.log.push(line)
		if (running.log.length > 120) running.log.shift()
	}
	if (running.child.stdout) {
		createInterface({ input: running.child.stdout }).on("line", keep)
	}
	if (running.child.stderr) {
		createInterface({ input: running.child.stderr }).on("line", keep)
	}
}

/** All descendant PIDs, read before a parent exits so no orphan is left behind. */
function descendants(pid: number): number[] {
	try {
		const table = execFileSync("ps", ["-axo", "pid=,ppid="], {
			encoding: "utf8",
			timeout: 3_000,
		})
		const children = new Map<number, number[]>()
		for (const line of table.split("\n")) {
			const [childRaw, parentRaw] = line.trim().split(/\s+/)
			const child = Number(childRaw)
			const parent = Number(parentRaw)
			if (!Number.isInteger(child) || !Number.isInteger(parent)) continue
			children.set(parent, [...(children.get(parent) ?? []), child])
		}
		const found: number[] = []
		const walk = (parent: number) => {
			for (const child of children.get(parent) ?? []) {
				found.push(child)
				walk(child)
			}
		}
		walk(pid)
		return found
	} catch {
		return []
	}
}

const signalTree = (root: number, signal: NodeJS.Signals): void => {
	const pids = [root, ...descendants(root)].filter(
		(pid) => pid > 1 && pid !== process.pid,
	)
	// Detached children are their own process-group leaders. Kill the groups first so a
	// grandchild that reparents to launchd cannot survive the npm wrapper.
	for (const pid of pids) {
		try {
			process.kill(-pid, signal)
		} catch {
			// not a group leader
		}
	}
	for (const pid of pids) {
		try {
			process.kill(pid, signal)
		} catch {
			// already gone
		}
	}
}

async function stop(running: Running): Promise<void> {
	const child = running.child
	if (child.pid === undefined) return
	signalTree(child.pid, "SIGTERM")
	await new Promise((resolve) => setTimeout(resolve, 3_000))
	signalTree(child.pid, "SIGKILL")
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2)
	const config = readOfflineConfig(process.env, argv)
	const plan = buildOfflinePlan(config, process.env)

	if (argv.includes("--print-plan")) {
		console.log(JSON.stringify(plan, null, 2))
		return
	}

	console.log(
		"offline  settlement=mock  providers=simulated  (no real money moves)",
	)
	console.log(`plan     API ${plan.api.url}  web ${plan.web.url}`)
	console.log(
		`seed     ${
			plan.seed.enabled
				? "enabled after startup"
				: `skipped: ${plan.seed.reason}`
		}`,
	)
	console.log(
		"start    API (embedded Postgres, migrations) then web; loopback only",
	)

	await assertPortFree(config.apiPort)
	await assertPortFree(config.webPort)

	const running: Running[] = []
	let stopping = false

	const shutdown = async (code: number): Promise<never> => {
		if (!stopping) {
			stopping = true
			console.log(
				"\nstop     sending SIGTERM to the launcher's own process groups",
			)
			await Promise.all(running.map((item) => stop(item)))
		}
		process.exit(code)
	}

	const start = (
		label: string,
		command: string,
		args: string[],
		env: NodeJS.ProcessEnv,
	): Running => {
		const child = spawn(command, args, {
			cwd: REPO_ROOT,
			env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		})
		const item: Running = { label, child, log: [] }
		capture(item)
		child.once("exit", (code, signal) => {
			if (stopping) return
			console.error(
				`\n${label} exited unexpectedly (${signal ?? `code ${code ?? "unknown"}`})`,
			)
			for (const line of item.log.slice(-25)) console.error(`${label} ${line}`)
			void shutdown(code === 0 ? 1 : (code ?? 1))
		})
		running.push(item)
		return item
	}

	process.once("SIGINT", () => void shutdown(0))
	process.once("SIGTERM", () => void shutdown(0))

	start("api", plan.api.command, plan.api.args, {
		...process.env,
		...plan.api.env,
	})
	start("web", plan.web.command, plan.web.args, {
		...process.env,
		...plan.web.env,
	})

	try {
		await waitForHttp(
			`${plan.api.url}/healthz`,
			config.apiTimeoutMs,
			"API healthz",
		)
		await waitForHttp(`${plan.web.url}/`, config.webTimeoutMs, "web")
	} catch (error) {
		console.error(
			`\noffline  ${error instanceof Error ? error.message : String(error)}`,
		)
		for (const item of running) {
			console.error(`--- last ${item.label} output ---`)
			for (const line of item.log.slice(-25)) console.error(line)
		}
		await shutdown(1)
	}

	console.log(`offline  open ${plan.web.url}  (API ${plan.api.url})`)

	if (plan.seed.enabled) {
		console.log("seed     running scripts/seed/seed.ts through the API")
		const seed = spawn(plan.seed.command, plan.seed.args, {
			cwd: REPO_ROOT,
			env: {
				...process.env,
				FP_API_URL: plan.seed.apiUrl,
				FP_SETTLEMENT: "mock",
			},
			stdio: "inherit",
		})
		const code = await new Promise<number>((resolve) => {
			seed.once("exit", (exitCode) => resolve(exitCode ?? 1))
		})
		if (code === 0) console.log("seed     PASS")
		else if (code === 2)
			console.log("seed     BLOCKED (see the blocker above); servers stay up")
		else console.log(`seed     FAIL (exit ${code}); servers stay up`)
	}

	console.log("offline  ready. Press Ctrl+C to stop both development servers.")
	await new Promise<void>(() => {})
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
	main().catch((error) => {
		console.error(
			`offline  FAIL  ${error instanceof Error ? error.message : String(error)}`,
		)
		process.exit(1)
	})
}
