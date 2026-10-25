import {
	request as httpRequest,
	type IncomingMessage,
	type OutgoingHttpHeaders,
	type ServerResponse,
} from "node:http"
import { request as httpsRequest } from "node:https"
import { type Connect, type Plugin } from "vite"

// CCR-19 minimal local proxy. Vite runs this in the Node process, so FP_API_KEY never enters
// the browser bundle. It forwards only the published API routes below and always strips any
// browser-supplied Authorization header. Public claim routes (CCR-21 passkey
// deploy/prepare/submit and the CCR-22 anchor price/withdraw/status/pay) are forwarded with
// no Bearer at all, including the upstream hop.

export type ProxyRouteKind = "protected" | "claim"

interface RouteRule {
	kind: ProxyRouteKind
	method: string
	path: RegExp
}

const protectedRule = (method: string, path: RegExp): RouteRule => ({
	kind: "protected",
	method,
	path,
})

const claimRule = (method: string, path: RegExp): RouteRule => ({
	kind: "claim",
	method,
	path,
})

// Only routes the web app or the accepted contract actually needs. A new API route must be
// added deliberately; this is not a catch-all proxy.
const ROUTES: readonly RouteRule[] = [
	claimRule("GET", /^\/v1\/claims\/[^/]+\/?$/),
	claimRule("POST", /^\/v1\/claims\/[^/]+\/accept\/?$/),
	// CCR-21: exactly the three public passkey claim routes, keyless upstream.
	claimRule("POST", /^\/v1\/claims\/[^/]+\/passkey\/deploy\/?$/),
	claimRule("POST", /^\/v1\/claims\/[^/]+\/passkey\/prepare\/?$/),
	claimRule("POST", /^\/v1\/claims\/[^/]+\/passkey\/submit\/?$/),
	// CCR-22: exactly the four public reference-anchor claim routes, keyless upstream.
	claimRule("POST", /^\/v1\/claims\/[^/]+\/anchor\/indicative-price\/?$/),
	claimRule("POST", /^\/v1\/claims\/[^/]+\/anchor\/withdraw\/?$/),
	claimRule("GET", /^\/v1\/claims\/[^/]+\/anchor\/withdraw\/[^/]+\/?$/),
	claimRule("POST", /^\/v1\/claims\/[^/]+\/anchor\/withdraw\/[^/]+\/pay\/?$/),
	protectedRule("GET", /^\/v1\/corridors\/?$/),
	protectedRule("GET", /^\/v1\/recipients\/?$/),
	protectedRule("POST", /^\/v1\/recipients\/?$/),
	protectedRule("POST", /^\/v1\/quotes\/?$/),
	protectedRule("GET", /^\/v1\/payments\/?$/),
	protectedRule("POST", /^\/v1\/payments\/?$/),
	protectedRule("GET", /^\/v1\/payments\/[^/]+\/?$/),
	protectedRule("POST", /^\/v1\/payments\/[^/]+\/fund\/?$/),
	protectedRule("POST", /^\/v1\/payments\/[^/]+\/cancel\/?$/),
	protectedRule("GET", /^\/v1\/events\/?$/),
	protectedRule("GET", /^\/v1\/endpoints\/?$/),
	protectedRule("POST", /^\/v1\/endpoints\/?$/),
	protectedRule("GET", /^\/v1\/batches\/?$/),
	protectedRule("POST", /^\/v1\/batches\/?$/),
	protectedRule("GET", /^\/v1\/batches\/[^/]+\/?$/),
	protectedRule(
		"POST",
		/^\/v1\/sandbox\/(?:fail-next|provider-health|reset|advance-time)\/?$/,
	),
]

const SAFE_PATH = /^(?!.*(?:%2f|%5c|%2e|\/\/|\/\.)).+$/i

/** Returns the proxy policy for an exact method + path, or null when it must not be forwarded. */
export function classifyProxyRequest(
	method: string,
	pathname: string,
): ProxyRouteKind | null {
	if (!SAFE_PATH.test(pathname)) return null
	// Reject traversal and equivalent paths before any route match.
	let normalized: string
	try {
		normalized = new URL(pathname, "http://proxy.invalid").pathname
	} catch {
		return null
	}
	if (normalized !== pathname) return null
	const verb = method.toUpperCase()
	return (
		ROUTES.find((route) => route.method === verb && route.path.test(pathname))
			?.kind ?? null
	)
}

export interface ProxyTarget {
	protocol: "http:" | "https:"
	hostname: string
	port: string
	host: string
}

export type TargetResult =
	{ ok: true; target: ProxyTarget } | { ok: false; problem: string }

/** FP_API_URL must be a bare http(s) origin; it is the only upstream this proxy can reach. */
export function parseProxyTarget(raw: string | undefined | null): TargetResult {
	const value = raw?.trim()
	if (!value) {
		return {
			ok: false,
			problem:
				"FP_API_URL is not set. Set it to the local API origin and restart Vite.",
		}
	}
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return { ok: false, problem: "FP_API_URL is not a valid URL." }
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { ok: false, problem: "FP_API_URL must use http or https." }
	}
	if (url.username || url.password) {
		return {
			ok: false,
			problem: "FP_API_URL must not contain credentials.",
		}
	}
	if (url.pathname !== "/" || url.search || url.hash) {
		return {
			ok: false,
			problem:
				"FP_API_URL must be an origin without a path, query or fragment.",
		}
	}
	return {
		ok: true,
		target: {
			protocol: url.protocol,
			// Node's URL keeps brackets on IPv6 literals; http.request wants the bare host.
			hostname: url.hostname.replace(/^\[|\]$/g, ""),
			port: url.port,
			host: url.host,
		},
	}
}

const REQUEST_HEADERS = [
	"accept",
	"content-type",
	"content-length",
	"idempotency-key",
	"user-agent",
] as const

const RESPONSE_SKIPPED_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"set-cookie",
	"transfer-encoding",
	"upgrade",
])

function json(
	res: ServerResponse,
	status: number,
	code: string,
	message: string,
): void {
	if (res.writableEnded) return
	res.statusCode = status
	res.setHeader("content-type", "application/json; charset=utf-8")
	res.setHeader("cache-control", "no-store")
	res.end(JSON.stringify({ code, message }))
}

function forwardResponse(upstream: IncomingMessage, res: ServerResponse): void {
	res.statusCode = upstream.statusCode ?? 502
	for (const [name, value] of Object.entries(upstream.headers)) {
		if (value === undefined || RESPONSE_SKIPPED_HEADERS.has(name)) continue
		res.setHeader(name, value)
	}
	upstream.pipe(res)
}

export interface ApiProxyOptions {
	target: string | undefined | null
	apiKey: string | undefined | null
}

export type ApiProxyMiddleware = (
	req: IncomingMessage,
	res: ServerResponse,
	next: Connect.NextFunction,
) => void

export function createApiProxyMiddleware({
	target: rawTarget,
	apiKey: rawKey,
}: ApiProxyOptions): ApiProxyMiddleware {
	const parsedTarget = parseProxyTarget(rawTarget)
	const apiKey = rawKey?.trim() ?? ""

	return (req, res, next) => {
		const rawUrl = req.url ?? "/"
		const pathname = rawUrl.split("?", 1)[0] ?? "/"
		if (!pathname.startsWith("/v1/")) {
			next()
			return
		}

		const kind = classifyProxyRequest(req.method ?? "GET", pathname)
		if (!kind) {
			json(
				res,
				404,
				"proxy_route_not_allowed",
				"The local web proxy does not forward this route.",
			)
			return
		}
		if (!parsedTarget.ok) {
			json(res, 503, "frontend_api_not_configured", parsedTarget.problem)
			return
		}
		if (kind === "protected" && !apiKey) {
			json(
				res,
				503,
				"frontend_auth_not_configured",
				"The local web proxy is missing server-side FP_API_KEY. Set it for the Vite server and restart.",
			)
			return
		}
		const headers: Record<string, string | string[]> = {}
		for (const name of REQUEST_HEADERS) {
			const value = req.headers[name]
			if (value !== undefined) headers[name] = value
		}

		headers.host = parsedTarget.target.host
		// Never trust a browser-supplied credential. Claims stay keyless upstream.
		if (kind === "protected") headers.authorization = `Bearer ${apiKey}`

		const send =
			parsedTarget.target.protocol === "https:" ? httpsRequest : httpRequest
		const upstream = send(
			{
				protocol: parsedTarget.target.protocol,
				hostname: parsedTarget.target.hostname,
				port: parsedTarget.target.port,
				method: req.method,
				path: rawUrl,
				headers: headers as OutgoingHttpHeaders,
			},
			(upstreamRes) => forwardResponse(upstreamRes, res),
		)

		upstream.on("error", () => {
			if (!res.headersSent) {
				json(
					res,
					502,
					"proxy_upstream_unreachable",
					"The local API could not be reached. Check that it is running and that FP_API_URL is correct.",
				)
			} else {
				res.destroy()
			}
		})
		req.on("aborted", () => upstream.destroy())
		req.pipe(upstream)
	}
}

/**
 * Local Vite only. A static build has no Node process, so this is not a deployed BFF and
 * must not be presented as authentication for hosting.
 */
export function apiProxyPlugin(options: ApiProxyOptions): Plugin {
	const middleware = createApiProxyMiddleware(options)
	return {
		name: "flexipay-local-api-proxy",
		configureServer(server) {
			if (!parseProxyTarget(options.target).ok) {
				server.config.logger.warn(
					"[flexipay-api-proxy] FP_API_URL is unset or invalid; API calls will return a configuration error.",
				)
			} else if (!options.apiKey?.trim()) {
				server.config.logger.warn(
					"[flexipay-api-proxy] FP_API_KEY is unset; protected API calls will return an authentication configuration error. Claims remain public.",
				)
			}
			server.middlewares.use(middleware)
		},
		configurePreviewServer(server) {
			server.middlewares.use(middleware)
		},
	}
}
