import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import {
	createServer as createHttpServer,
	type IncomingMessage,
	type Server,
} from "node:http"
import { type AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "vite"
import { afterAll, beforeAll, describe, test } from "vitest"
import {
	classifyProxyRequest,
	createApiProxyMiddleware,
	parseProxyTarget,
} from "./vite.proxy.ts"

interface Seen {
	method: string | undefined
	url: string | undefined
	headers: IncomingMessage["headers"]
	body: string
}

const listen = (server: Server): Promise<number> =>
	new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => {
			resolve((server.address() as AddressInfo).port)
		})
	})

const close = (server: Server): Promise<void> =>
	new Promise((resolve) => server.close(() => resolve()))

const startProxy = async (
	target: string | undefined,
	apiKey: string | undefined,
): Promise<{ server: Server; url: string }> => {
	const middleware = createApiProxyMiddleware({ target, apiKey })
	const server = createHttpServer((req, res) => {
		middleware(req, res, () => {
			res.statusCode = 404
			res.end("not the proxy")
		})
	})
	const port = await listen(server)
	return { server, url: `http://127.0.0.1:${port}` }
}

describe("CCR-19 proxy route policy", () => {
	test("allows only intended protected and claim routes", () => {
		assert.equal(classifyProxyRequest("GET", "/healthz"), "claim")
		assert.equal(classifyProxyRequest("POST", "/v1/quotes"), "protected")
		assert.equal(classifyProxyRequest("GET", "/v1/corridors"), "protected")
		assert.equal(classifyProxyRequest("GET", "/v1/recipients"), "protected")
		assert.equal(classifyProxyRequest("GET", "/v1/payments/pay_1"), "protected")
		assert.equal(
			classifyProxyRequest("POST", "/v1/payments/pay_1/fund"),
			"protected",
		)
		assert.equal(
			classifyProxyRequest("GET", "/v1/payments/pay_1/solana/intent"),
			"protected",
		)
		assert.equal(
			classifyProxyRequest("POST", "/v1/payments/pay_1/solana/confirm"),
			"protected",
		)
		assert.equal(classifyProxyRequest("POST", "/v1/endpoints"), "protected")
		assert.equal(classifyProxyRequest("POST", "/v1/batches"), "protected")
		assert.equal(classifyProxyRequest("POST", "/v1/sandbox/reset"), "protected")

		assert.equal(classifyProxyRequest("GET", "/v1/solana/config"), "claim")
		assert.equal(classifyProxyRequest("GET", "/v1/claims/token_1"), "claim")
		assert.equal(
			classifyProxyRequest("POST", "/v1/claims/token_1/accept"),
			"claim",
		)
	})

	test("rejects everything else", () => {
		for (const [method, path] of [
			["POST", "/healthz"],
			["GET", "/v1/admin"],
			["GET", "/v1/claims/token_1/accept"],
			["POST", "/v1/claims/token_1"],
			["POST", "/v1/claims/token_1/passkey/deploy"],
			["POST", "/v1/claims/token_1/passkey/prepare"],
			["POST", "/v1/claims/token_1/passkey/submit"],
			["POST", "/v1/claims/token_1/anchor/indicative-price"],
			["POST", "/v1/claims/token_1/anchor/withdraw"],
			["GET", "/v1/claims/token_1/anchor/withdraw/tx_1"],
			["POST", "/v1/claims/token_1/anchor/withdraw/tx_1/pay"],
			["GET", "/v1/payments/pay_1/fund"],
			["POST", "/v1/payments/pay_1/fund/extra"],
			["GET", "/v1/payments/../claims/token_1"],
			["GET", "/v1/payments/%2e%2e/claims/token_1"],
			["GET", "/v1/payments//pay_1"],
		] as const) {
			assert.equal(
				classifyProxyRequest(method, path),
				null,
				`${method} ${path}`,
			)
		}
	})

	test("accepts only a bare http(s) origin", () => {
		assert.equal(parseProxyTarget(undefined).ok, false)
		assert.equal(parseProxyTarget("not a url").ok, false)
		assert.equal(parseProxyTarget("ftp://127.0.0.1:8788").ok, false)
		assert.equal(parseProxyTarget("http://user:pass@127.0.0.1:8788").ok, false)
		assert.equal(parseProxyTarget("http://127.0.0.1:8788/api").ok, false)
		assert.equal(parseProxyTarget("http://127.0.0.1:8788?x=1").ok, false)
		assert.equal(parseProxyTarget("http://127.0.0.1:8788").ok, true)
		assert.equal(parseProxyTarget("https://api.example.test").ok, true)
	})
})

describe("CCR-19 proxy upstream behaviour", () => {
	let upstream: Server
	let upstreamUrl: string
	let seen: Seen[] = []

	beforeAll(async () => {
		upstream = createHttpServer((req, res) => {
			const chunks: Buffer[] = []
			req.on("data", (chunk: Buffer) => chunks.push(chunk))
			req.on("end", () => {
				seen.push({
					method: req.method,
					url: req.url,
					headers: req.headers,
					body: Buffer.concat(chunks).toString("utf8"),
				})
				res.setHeader("content-type", "application/json")
				res.setHeader("set-cookie", "should-not-reach-browser=1")
				res.end(JSON.stringify({ received: true }))
			})
		})
		const port = await listen(upstream)
		upstreamUrl = `http://127.0.0.1:${port}`
	})

	afterAll(async () => {
		await close(upstream)
	})

	test("injects server-side Bearer and preserves body/idempotency", async () => {
		seen = []
		const proxy = await startProxy(upstreamUrl, "server-side-test-key")
		try {
			const response = await fetch(`${proxy.url}/v1/quotes?trace=1`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "idem-test-1",
					authorization: "Bearer browser-attempt",
				},
				body: JSON.stringify({ amount: "100" }),
			})
			assert.equal(response.status, 200)
			assert.equal(response.headers.get("set-cookie"), null)
			assert.equal(seen.length, 1)
			assert.equal(seen[0]?.url, "/v1/quotes?trace=1")
			assert.equal(
				seen[0]?.headers.authorization,
				"Bearer server-side-test-key",
			)
			assert.equal(seen[0]?.headers["idempotency-key"], "idem-test-1")
			assert.equal(seen[0]?.body, '{"amount":"100"}')
			assert.doesNotMatch(await response.text(), /server-side-test-key/)
		} finally {
			await close(proxy.server)
		}
	})

	test("forwards public claim GET and accept without any Bearer", async () => {
		seen = []
		const proxy = await startProxy(upstreamUrl, "server-side-test-key")
		try {
			const get = await fetch(`${proxy.url}/v1/claims/token_1`, {
				headers: { authorization: "Bearer browser-attempt" },
			})
			assert.equal(get.status, 200)

			const accept = await fetch(`${proxy.url}/v1/claims/token_1/accept`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer browser-attempt",
					"idempotency-key": "claim-test-1",
				},
				body: JSON.stringify({ endpoint: { type: "crypto_wallet" } }),
			})
			assert.equal(accept.status, 200)

			assert.equal(seen.length, 2)
			assert.equal(seen[0]?.headers.authorization, undefined)
			assert.equal(seen[1]?.headers.authorization, undefined)
			assert.equal(seen[1]?.headers["idempotency-key"], "claim-test-1")
		} finally {
			await close(proxy.server)
		}
	})

	test("does not forward an unlisted route", async () => {
		seen = []
		const proxy = await startProxy(upstreamUrl, "server-side-test-key")
		try {
			const response = await fetch(`${proxy.url}/v1/admin`)
			assert.equal(response.status, 404)
			const payload = (await response.json()) as { code?: string }
			assert.equal(payload.code, "proxy_route_not_allowed")
			assert.equal(seen.length, 0)
		} finally {
			await close(proxy.server)
		}
	})

	test("missing key returns an honest config error but claims still work keyless", async () => {
		seen = []
		const proxy = await startProxy(upstreamUrl, "")
		try {
			const blocked = await fetch(`${proxy.url}/v1/quotes`, { method: "POST" })
			assert.equal(blocked.status, 503)
			const body = (await blocked.json()) as {
				code?: string
				message?: string
			}
			assert.equal(body.code, "frontend_auth_not_configured")
			assert.match(body.message ?? "", /FP_API_KEY/)
			assert.equal(seen.length, 0)

			const claim = await fetch(`${proxy.url}/v1/claims/token_1`)
			assert.equal(claim.status, 200)
			assert.equal(seen.length, 1)
			assert.equal(seen[0]?.headers.authorization, undefined)
		} finally {
			await close(proxy.server)
		}
	})

	test("missing or invalid target returns a configuration error", async () => {
		for (const target of [
			undefined,
			"http://127.0.0.1:8788/api",
			"ftp://x.test",
		]) {
			const proxy = await startProxy(target, "server-side-test-key")
			try {
				const response = await fetch(`${proxy.url}/v1/claims/token_1`)
				assert.equal(response.status, 503)
				const payload = (await response.json()) as { code?: string }
				assert.equal(payload.code, "frontend_api_not_configured")
			} finally {
				await close(proxy.server)
			}
		}
	})
})

describe("CCR-19 runtime key stays out of the browser bundle", () => {
	test("a sentinel FP_API_KEY never appears in any built asset", async () => {
		const sentinel = "fp-sentinel-6c1f0f4e9b2a47d8"
		const previous = process.env.FP_API_KEY
		process.env.FP_API_KEY = sentinel
		const outDir = await mkdtemp(join(tmpdir(), "flexipay-bundle-"))
		try {
			await build({
				root: import.meta.dirname,
				configFile: join(import.meta.dirname, "vite.config.ts"),
				logLevel: "silent",
				build: { outDir, emptyOutDir: true },
			})
			const entries = await readdir(outDir, { recursive: true })
			for (const entry of entries) {
				if (!/\.(?:js|css|html|json|map)$/i.test(entry)) continue
				const text = await readFile(join(outDir, entry), "utf8")
				assert.ok(
					!text.includes(sentinel),
					`${entry} contains the server-side FP_API_KEY`,
				)
			}
		} finally {
			if (previous === undefined) delete process.env.FP_API_KEY
			else process.env.FP_API_KEY = previous
			await rm(outDir, { recursive: true, force: true })
		}
	}, 120_000)
})

describe("TASK 06 proxy: customer sessions", () => {
	let upstream: Server
	let upstreamUrl: string
	let seen: Seen[] = []

	beforeAll(async () => {
		upstream = createHttpServer((req, res) => {
			req.resume()
			req.on("end", () => {
				seen.push({
					method: req.method,
					url: req.url,
					headers: req.headers,
					body: "",
				})
				res.setHeader("content-type", "application/json")
				res.setHeader("set-cookie", "fp.session_token=abc; HttpOnly")
				res.end("{}")
			})
		})
		upstreamUrl = `http://127.0.0.1:${await listen(upstream)}`
	})
	afterAll(async () => {
		await close(upstream)
	})

	test("classifies the auth and session routes", () => {
		assert.equal(
			classifyProxyRequest("POST", "/api/auth/sign-in/email"),
			"auth",
		)
		assert.equal(classifyProxyRequest("GET", "/api/auth/verify-email"), "auth")
		assert.equal(classifyProxyRequest("GET", "/v1/me"), "protected")
		assert.equal(classifyProxyRequest("POST", "/v1/api-keys"), "protected")
		assert.equal(
			classifyProxyRequest("DELETE", "/api/auth/sign-in/email"),
			null,
		)
		assert.equal(classifyProxyRequest("GET", "/api/auth/../v1/me"), null)
		assert.equal(classifyProxyRequest("GET", "/api/other"), null)
	})

	test("a signed-in customer is forwarded with their cookie and WITHOUT the server key", async () => {
		seen = []
		const proxy = await startProxy(upstreamUrl, "server-side-test-key")
		try {
			const res = await fetch(`${proxy.url}/v1/recipients`, {
				method: "POST",
				headers: {
					cookie: "fp.session_token=user-cookie",
					origin: "http://localhost:5173",
					"content-type": "application/json",
				},
				body: "{}",
			})
			assert.equal(res.status, 200)
			assert.equal(seen[0]?.headers.authorization, undefined)
			assert.equal(seen[0]?.headers.cookie, "fp.session_token=user-cookie")
			assert.equal(seen[0]?.headers.origin, "http://localhost:5173")
			// Cookies are only ever set through the auth routes.
			assert.equal(res.headers.get("set-cookie"), null)
		} finally {
			await close(proxy.server)
		}
	})

	test("auth routes pass cookies both ways and never receive the server key", async () => {
		seen = []
		const proxy = await startProxy(upstreamUrl, "server-side-test-key")
		try {
			const res = await fetch(`${proxy.url}/api/auth/sign-in/email`, {
				method: "POST",
				headers: {
					origin: "http://localhost:5173",
					authorization: "Bearer browser-attempt",
					"content-type": "application/json",
				},
				body: "{}",
			})
			assert.match(res.headers.get("set-cookie") ?? "", /fp\.session_token=abc/)
			assert.equal(seen[0]?.headers.authorization, undefined)
			assert.equal(seen[0]?.headers.origin, "http://localhost:5173")
		} finally {
			await close(proxy.server)
		}
	})

	test("public claims never receive a cookie", async () => {
		seen = []
		const proxy = await startProxy(upstreamUrl, "server-side-test-key")
		try {
			await fetch(`${proxy.url}/v1/claims/token_1`, {
				headers: { cookie: "fp.session_token=user-cookie" },
			})
			assert.equal(seen[0]?.headers.cookie, undefined)
			assert.equal(seen[0]?.headers.authorization, undefined)
		} finally {
			await close(proxy.server)
		}
	})

	test("with no key configured, a session cookie still reaches protected routes", async () => {
		seen = []
		const proxy = await startProxy(upstreamUrl, "")
		try {
			const res = await fetch(`${proxy.url}/v1/me`, {
				headers: { cookie: "__Secure-fp.session_token=x" },
			})
			assert.equal(res.status, 200)
			const none = await fetch(`${proxy.url}/v1/me`)
			assert.equal(none.status, 503)
		} finally {
			await close(proxy.server)
		}
	})
})
