import {
	CreateEndpointRequestSchema,
	EndpointSchema,
	SandboxResetRequestSchema,
} from "@flexipay/domain"
import {
	endpointWireFields,
	type Fixtures,
	type FixtureWorker,
} from "../../demo/lib/fixtures.ts"
import type { ApiResponse, HttpClient } from "../../demo/lib/http.ts"
import { BlockedError } from "../../demo/lib/report.ts"

// Seed/reset through the API only. `POST /v1/sandbox/reset` has an A0 request schema but no
// response body; recipients and endpoints use the mounted CCR-16/17 routes and schemas. Nothing
// is copied into Postgres directly, and no field is invented.

export interface SeedHooks {
	step(name: string): void
}

export interface SeedRecipient {
	ref: string
	id: string
	name: string
}

export interface SeedEndpoint {
	ref: string
	id: string
	recipientRef: string
	type: string
}

export interface SeedOutcome {
	resetStatus: number
	recipients: SeedRecipient[]
	endpoints: SeedEndpoint[]
}

export interface SeedOptions {
	/** `reset` only calls the sandbox reset; `seed` also creates the neutral fixtures. */
	command?: "seed" | "reset"
	hooks?: SeedHooks
}

const ok = (status: number): boolean => status >= 200 && status < 300

function responseDetail(label: string, response: ApiResponse): string {
	const body = response.body as
		{ code?: unknown; message?: unknown } | undefined
	const code = typeof body?.code === "string" ? ` code=${body.code}` : ""
	const message =
		typeof body?.message === "string" ? ` message=${body.message}` : ""
	return `${label} returned HTTP ${response.status}${code}${message}`
}

async function reset(http: HttpClient, hooks?: SeedHooks): Promise<number> {
	// Reset must execute on every seed run. Sending an Idempotency-Key makes the API replay
	// the first cached 200 without deleting anything, so a second seed would reuse stale rows.
	const response = await http.call("POST", "/v1/sandbox/reset", {
		body: SandboxResetRequestSchema.parse({}),
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

async function seedEndpoints(
	http: HttpClient,
	workers: readonly FixtureWorker[],
	recipients: readonly SeedRecipient[],
	hooks?: SeedHooks,
): Promise<SeedEndpoint[]> {
	const created: SeedEndpoint[] = []
	for (const worker of workers) {
		const recipient = recipients.find((r) => r.ref === worker.ref)
		if (!recipient) {
			throw new Error(
				`recipient ${worker.ref} was not created before its endpoints`,
			)
		}
		for (const endpoint of worker.endpoints) {
			const wire = endpointWireFields(endpoint)
			const body = CreateEndpointRequestSchema.parse({
				recipientId: recipient.id,
				type: endpoint.type,
				country: wire.country,
				currency: endpoint.currency,
				network: wire.network,
				details: wire.details,
				simulated: true,
			})
			const response = await http.call("POST", "/v1/endpoints", {
				body,
				idempotencyKey: `seed:endpoint:${worker.ref}:${endpoint.ref}`,
			})
			if (response.status === 404) {
				throw new BlockedError([
					{
						what: "POST /v1/endpoints is not mounted",
						owner: "Csaba (CC3b)",
						detail:
							"CCR-16/17 requires the endpoint route for fixture destinations.",
					},
				])
			}
			if (!ok(response.status)) {
				throw new Error(
					responseDetail(
						`POST /v1/endpoints (${worker.ref}/${endpoint.ref})`,
						response,
					),
				)
			}
			const parsed = EndpointSchema.parse(response.body)
			if (parsed.recipientId !== recipient.id) {
				throw new Error(
					`POST /v1/endpoints (${worker.ref}/${endpoint.ref}) returned recipient ${parsed.recipientId}, expected ${recipient.id}`,
				)
			}
			created.push({
				ref: endpoint.ref,
				id: parsed.id,
				recipientRef: worker.ref,
				type: parsed.type,
			})
			hooks?.step(
				`seed    endpoint ${worker.ref}/${endpoint.ref}  ${parsed.id}`,
			)
		}
	}
	return created
}

/**
 * Resets, then creates every neutral recipient and endpoint from
 * `scripts/seed/fixtures/workers.json` through the mounted API routes.
 */
export async function runSeed(
	http: HttpClient,
	fixtures: Fixtures,
	options: SeedOptions = {},
): Promise<SeedOutcome> {
	const command = options.command ?? "seed"
	const resetStatus = await reset(http, options.hooks)
	if (command === "reset") {
		return { resetStatus, recipients: [], endpoints: [] }
	}

	const recipients = await seedRecipients(http, fixtures, options.hooks)
	const endpoints = await seedEndpoints(
		http,
		fixtures.workers,
		recipients,
		options.hooks,
	)
	return { resetStatus, recipients, endpoints }
}
