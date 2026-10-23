import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Evidence is what a reviewer reads instead of a claimed pass: commit, command, exit code and the
// assertion lines. It carries no API key, claim token, environment dump or request/response body.

export interface EvidenceRecord {
	flow: string
	title: string
	mode: string
	status: "PASS" | "FAIL" | "BLOCKED"
	exitCode: number
	command: string
	commit: string
	startedAt: string
	finishedAt: string
	steps: { kind: string; text: string }[]
	blockers: { what: string; owner: string; detail?: string }[]
	failure?: string
	sanitised: true
}

const stamp = (date: Date): string => date.toISOString().replace(/[:.]/g, "-")

/** Deep redaction of any known secret value that slipped into a message. */
function redact(value: unknown, secrets: readonly string[]): unknown {
	if (typeof value === "string") {
		return secrets.reduce(
			(text, secret) => (secret ? text.split(secret).join("[redacted]") : text),
			value,
		)
	}
	if (Array.isArray(value)) return value.map((item) => redact(item, secrets))
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, item]) => [
				key,
				redact(item, secrets),
			]),
		)
	}
	return value
}

/** Writes the record and returns its repo-relative path. */
export function writeEvidence(
	dir: string,
	record: EvidenceRecord,
	secrets: readonly string[],
): string {
	mkdirSync(dir, { recursive: true })
	const name = `${record.flow.toLowerCase()}-${record.mode}-${stamp(new Date())}.json`
	const path = join(dir, name)
	writeFileSync(
		path,
		`${JSON.stringify(redact(record, secrets), null, 2)}\n`,
		"utf8",
	)
	return path
}
