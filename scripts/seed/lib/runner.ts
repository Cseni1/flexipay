import { SandboxResetRequestSchema } from "@flexipay/domain"
import type { Fixtures } from "../../demo/lib/fixtures.ts"
import type { ApiResponse, HttpClient } from "../../demo/lib/http.ts"
import { BlockedError, type Blocker } from "../../demo/lib/report.ts"

// Seed/reset through the API only. `POST /v1/sandbox/reset` has an A0 request schema but no
// response body; recipients have a mounted route and a schema. Endpoint creation has neither a
// route on main nor an A0 request schema, so this runner stops there rather than inventing
// `/v1/endpoints` fields or writing the database directly.

export interface SeedHooks {
	step(name: string): void
}

export interface SeedRecipient {
	ref: string
	id: string
	name: string
}

export interface SeedOutcome {
	resetStatus: number
	recipients: SeedRecipient[]
}

export interface SeedOptions {
	/** `reset` only calls the sandbox reset; `seed` also creates the neutral fixtures. */
	command?: "seed" | "reset"
	hooks?: SeedHooks
}

const ok = (status: number): boolean => status >= 200 && status < 300

function endpointBlocker(detail: string): Blocker {
	return {
		what: "POST /v1/endpoints and its A0 request schema are absent, so endpoints cannot be created without inventing fields",
		owner: "Csaba (A0/CC3b)",
		detail,
	}
}

function responseDetail(label: string, response: ApiResponse): string {
	const body = response.body as
		{ code?: unknown; message?: unknown } | undefined
	const code = typeof body?.code === "string" ? ` code=${body.code}` : ""
	const message =
		typeof body?.message === "string" ? ` message=${body.message}` : ""
	return `${label} returned HTTP ${response.status}${code}${message}`
}

async function reset(http: HttpClient, hooks?: SeedHooks): Promise<number> {
	const response = await http.call("POST", "/v1/sandbox/reset", {
		body: SandboxResetRequestSchema.parse({}),
		idempotencyKey: "seed:reset",
	})
	if (response.status === 404) {
		throw new BlockedError([
			{
				what: "POST /v1/sandbox/reset is not mounted",
				owner: "Csaba (CC3b)",
				detail:
					"ARCHITECTURE §10 and DEV_PLAN D2 require it; A0 already exports SandboxResetRequestSchema (empty body).",
			},
		])
	}
	if (!ok(response.status)) {
		throw new Error(responseDetail("POST /v1/sandbox/reset", response))
	}
	hooks?.step(`reset   POST /v1/sandbox/reset  HTTP ${response.status}`)
	return response.status
}

/**
 * The endpoint family is probed with GET, which cannot create data. A 404 means the route is not
 * mounted; a 2xx/4xx means it is mounted, but A0 still has no create-request schema. Either way the
 * seed cannot continue without guessing request fields.
 */
async function probeEndpoints(
	http: HttpClient,
	hooks?: SeedHooks,
): Promise<boolean> {
	const response = await http.call("GET", "/v1/endpoints")
	if (response.status === 404) {
		hooks?.step("probe   GET /v1/endpoints  HTTP 404  not mounted")
		return false
	}
	if (response.status === 401) {
		throw new Error(responseDetail("GET /v1/endpoints", response))
	}
	hooks?.step(`probe   GET /v1/endpoints  HTTP ${response.status}  mounted`)
	return true
}

async function seedRecipients(
	http: HttpClient,
	fixtures: Fixtures,
	hooks?: SeedHooks,
): Promise<SeedRecipient[]> {
	const created: SeedRecipient[] = []
	for (const worker of fixtures.workers) {
		const response = await http.call<{ id?: unknown; name?: unknown }>(
			"POST",
			"/v1/recipients",
			{
				body: {
					name: worker.name,
					kind: worker.kind,
					country: worker.country,
				},
				idempotencyKey: `seed:recipient:${worker.ref}`,
			},
		)
		if (response.status === 404) {
			throw new BlockedError([
				{
					what: "POST /v1/recipients is not mounted",
					owner: "Csaba (CC3a)",
					detail:
						"The seed fixtures cannot be created without the recipient route.",
				},
			])
		}
		if (!ok(response.status)) {
			throw new Error(
				responseDetail(`POST /v1/recipients (${worker.ref})`, response),
			)
		}
		const id = response.body?.id
		if (typeof id !== "string" || id.length === 0) {
			throw new Error(`POST /v1/recipients (${worker.ref}) returned no id`)
		}
		created.push({ ref: worker.ref, id, name: worker.name })
		hooks?.step(`seed    recipient ${worker.name}  ${id}`)
	}
	return created
}

/**
 * Resets, then creates the neutral recipients from `scripts/seed/fixtures/workers.json`.
 * Endpoint creation is deliberately not attempted: it would require inventing a contract.
 */
export async function runSeed(
	http: HttpClient,
	fixtures: Fixtures,
	options: SeedOptions = {},
): Promise<SeedOutcome> {
	const command = options.command ?? "seed"
	const resetStatus = await reset(http, options.hooks)
	if (command === "reset") {
		return { resetStatus, recipients: [] }
	}

	const recipients = await seedRecipients(http, fixtures, options.hooks)
	const mounted = await probeEndpoints(http, options.hooks)
	throw new BlockedError([
		endpointBlocker(
			mounted
				? "The endpoint route family is mounted, but no A0 request/response schema exists for POST /v1/endpoints; lane D does not invent one."
				: "GET /v1/endpoints returned 404; no endpoint route is mounted on this build.",
		),
	])
}
