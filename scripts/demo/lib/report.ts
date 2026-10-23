import { execFileSync } from "node:child_process"
import { relative } from "node:path"
import { AssertionFailure } from "./assertions.ts"
import { maskPath, maskValue, REPO_ROOT, type SettlementMode } from "./env.ts"
import { writeEvidence, type EvidenceRecord } from "./evidence.ts"
import { NetworkFailure } from "./http.ts"
import type { LegView } from "./types.ts"

// A DF run prints what it called, what ran and what happened, then exits 0 (PASS), 1 (FAIL) or
// 2 (BLOCKED). BLOCKED means a prerequisite is missing and is never reported as a pass.

export const EXIT = { PASS: 0, FAIL: 1, BLOCKED: 2 } as const

export interface Blocker {
	what: string
	owner: string
	detail?: string
}

export class BlockedError extends Error {
	readonly blockers: Blocker[]

	constructor(blockers: Blocker[]) {
		super(blockers.map((b) => b.what).join("; "))
		this.name = "BlockedError"
		this.blockers = blockers
	}
}

export interface FlowInfo {
	id: string
	title: string
	mode: SettlementMode
	evidenceDir: string
	command?: string
}

const commit = (): string => {
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			timeout: 5_000,
		}).trim()
	} catch {
		return "unavailable"
	}
}

const describeRef = (ref: string | undefined): string => {
	if (!ref) return ""
	if (/^[0-9a-f]{64}$/.test(ref)) return ` tx=${ref}`
	if (/^mock-/i.test(ref)) return ` ref=${ref}`
	return ` ref=${maskValue(ref)}`
}

export class Flow {
	readonly info: FlowInfo
	private readonly started = new Date()
	private readonly entries: { kind: string; text: string }[] = []
	private assertions = 0

	constructor(info: FlowInfo) {
		this.info = info
		this.header()
	}

	header(): void {
		console.log(`\n${this.info.id}  ${this.info.title} (${this.info.mode})`)
		console.log(`commit ${commit()}  settlement ${this.info.mode}`)
	}

	route(method: "GET" | "POST", path: string, detail = ""): void {
		const line = `${method} ${maskPath(path)}${detail ? `  ${detail}` : ""}`
		console.log(`route  ${line}`)
		this.entries.push({ kind: "route", text: line })
	}

	legs(label: string, legs: readonly LegView[]): void {
		for (const l of legs) {
			const attempt = l.attempt === undefined ? "" : ` #${l.attempt}`
			const error = l.error?.code ? ` error=${l.error.code}` : ""
			console.log(
				`legs   ${label} ${l.kind} ${l.rail} ${l.status}${attempt}${error}${describeRef(l.externalRef)}`,
			)
			this.entries.push({
				kind: "legs",
				text: `${label} ${l.kind} ${l.rail} ${l.status}${attempt}${error}${describeRef(l.externalRef)}`,
			})
		}
	}

	check(name: string): void {
		this.assertions += 1
		console.log(`check  ${name}  ok`)
		this.entries.push({ kind: "check", text: name })
	}

	note(message: string): void {
		console.log(`note   ${message}`)
		this.entries.push({ kind: "note", text: message })
	}

	finish(
		status: "PASS" | "FAIL" | "BLOCKED",
		blockers: Blocker[] = [],
		failure?: string,
	): never {
		for (const blocker of blockers) {
			console.log(`blocked ${blocker.what}  [owner: ${blocker.owner}]`)
		}
		if (failure) console.log(`error  ${failure}`)
		const exitCode = EXIT[status]
		console.log(`result ${status}`)
		const record: EvidenceRecord = {
			flow: this.info.id,
			title: this.info.title,
			mode: this.info.mode,
			status,
			exitCode,
			command:
				this.info.command ??
				`node ${relative(REPO_ROOT, process.argv[1] ?? "scripts/demo")} ${process.argv.slice(2).join(" ")}`.trim(),
			commit: commit(),
			startedAt: this.started.toISOString(),
			finishedAt: new Date().toISOString(),
			steps: this.entries,
			blockers,
			...(failure ? { failure } : {}),
			sanitised: true,
		}
		const path = writeEvidence(this.info.evidenceDir, record, [
			process.env.FP_API_KEY ?? "",
		])
		console.log(`evidence ${relative(REPO_ROOT, path)}`)
		process.exit(exitCode)
	}
}

export async function runFlow(
	flow: Flow,
	body: () => Promise<void>,
): Promise<never> {
	try {
		await body()
		return flow.finish("PASS")
	} catch (error) {
		if (error instanceof BlockedError)
			return flow.finish("BLOCKED", error.blockers)
		if (error instanceof AssertionFailure || error instanceof NetworkFailure) {
			return flow.finish("FAIL", [], error.message)
		}
		const message =
			error instanceof Error ? `${error.name}: ${error.message}` : String(error)
		return flow.finish("FAIL", [], message)
	}
}
