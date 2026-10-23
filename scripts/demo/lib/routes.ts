import type { RouteNeed } from "./preflight.ts"

// Routes each DF script needs, from ARCHITECTURE §10. They are checked against the API's own
// OpenAPI inventory before a flow starts, so a missing route is BLOCKED, not a confusing 404.

const recipients: RouteNeed = {
	method: "POST",
	path: "/v1/recipients",
	purpose: "create Worker A to Worker D",
}
const endpoints: RouteNeed = {
	method: "POST",
	path: "/v1/endpoints",
	purpose: "attach the worker's payout endpoint",
}
const quotes: RouteNeed = {
	method: "POST",
	path: "/v1/quotes",
	purpose: "route, fees, FX and validity",
}
const createPayment: RouteNeed = {
	method: "POST",
	path: "/v1/payments",
	purpose: "create a payment from a quote",
}
const fundPayment: RouteNeed = {
	method: "POST",
	path: "/v1/payments/{id}/fund",
	purpose: "run the legs",
}
const readPayment: RouteNeed = {
	method: "GET",
	path: "/v1/payments/{id}",
	purpose: "status, legs and events",
}
const events: RouteNeed = {
	method: "GET",
	path: "/v1/events",
	purpose: "payment timeline",
}

export const ROUTES = {
	df1: [
		recipients,
		endpoints,
		{ method: "POST", path: "/v1/batches", purpose: "three-worker JSON batch" },
		fundPayment,
		readPayment,
		{
			method: "GET",
			path: "/v1/batches/{id}",
			purpose: "batch totals and per-payment results",
		},
		events,
	],
	df2: [
		recipients,
		endpoints,
		quotes,
		createPayment,
		fundPayment,
		readPayment,
		events,
	],
	df3: [
		recipients,
		endpoints,
		quotes,
		createPayment,
		fundPayment,
		readPayment,
		{ method: "GET", path: "/v1/claims/{token}", purpose: "public claim view" },
		{
			method: "POST",
			path: "/v1/claims/{token}/accept",
			purpose: "public acceptance and release",
		},
		events,
	],
	df4: [
		recipients,
		endpoints,
		quotes,
		createPayment,
		fundPayment,
		readPayment,
		{
			method: "POST",
			path: "/v1/sandbox/fail-next",
			purpose: "force the BR payout attempts to fail",
		},
		events,
	],
	df5: [
		recipients,
		endpoints,
		quotes,
		createPayment,
		fundPayment,
		readPayment,
		events,
	],
} satisfies Record<string, RouteNeed[]>
