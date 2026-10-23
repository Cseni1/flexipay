import { existsSync } from "node:fs"
import type { DemoEnv } from "./env.ts"
import { A0_DIR } from "./preflight.ts"
import { BlockedError } from "./report.ts"
import type { DemoApi } from "./types.ts"

// The single seam between a flow and the API's wire contract. Building a URL, body or envelope
// here without A0 would be guessing, so this file deliberately refuses to return a client until
// the shared schemas exist. The flows above it are already written in semantic terms.

export const A0_REQUIREMENTS = [
	"Zod schemas for POST /v1/quotes and the quote response (route, fees, fxRate, expectedReceive, validUntil, alternatives, reasons, simulated)",
	"Zod schemas for POST /v1/payments, POST /v1/payments/{id}/fund, GET /v1/payments/{id} (status, legs, settlement reference, events)",
	"Zod schemas for POST /v1/batches and GET /v1/batches/{id} (rows, totals, per-payment result and reasons)",
	"Zod schemas for GET /v1/claims/{token} and POST /v1/claims/{token}/accept",
	"Zod schemas for GET /v1/events and the sandbox controls used by DF4",
	"Endpoint create schema (endpoint type, country, currency, network, details) and its success code",
]

export function loadDemoApi(env: DemoEnv): DemoApi {
	if (!existsSync(A0_DIR)) {
		throw new BlockedError([
			{
				what: "A0 API contracts are absent, so no request body or response can be built",
				owner: "Csaba (A0)",
				detail: A0_REQUIREMENTS.join(" | "),
			},
		])
	}
	throw new BlockedError([
		{
			what: "A0 contracts exist but lane D has no wire adapter bound to them in this branch",
			owner: "lane D (next D1 run)",
			detail:
				`Map DemoApi to the A0 schemas and the generated ${env.openapiPath}; ` +
				"no flow may construct a field outside those schemas.",
		},
	])
}
