import assert from "node:assert/strict"
import {
	createServer as createHttpServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http"
import { type AddressInfo } from "node:net"
import { afterEach, describe, test } from "vitest"
import {
	ApiError,
	createApiKey,
	listApiKeys,
	revokeApiKey,
} from "../src/api/client.ts"

const listen = (server: Server): Promise<number> =>
	new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => {
			resolve((server.address() as AddressInfo).port)
		})
	})

const close = (server: Server): Promise<void> =>
	new Promise((resolve) => server.close(() => resolve()))

const readBody = (req: IncomingMessage): Promise<string> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
		req.on("error", reject)
	})

describe("API keys client (session routes)", () => {
	let server: Server | undefined
	let originalFetch: typeof fetch | undefined
	const seen: Array<{
		method: string | undefined
		url: string | undefined
		authorization: string | undefined
		idempotency: string | undefined
		body: string
	}> = []

	afterEach(async () => {
		if (originalFetch) {
			globalThis.fetch = originalFetch
			originalFetch = undefined
		}
		if (server) {
			await close(server)
			server = undefined
		}
		seen.length = 0
	})

	const start = async (
		handler: (
			req: IncomingMessage,
			res: ServerResponse,
		) => void | Promise<void>,
	): Promise<void> => {
		server = createHttpServer((req, res) => {
			void (async () => {
				const body = await readBody(req)
				seen.push({
					method: req.method,
					url: req.url,
					authorization: req.headers.authorization,
					idempotency:
						typeof req.headers["idempotency-key"] === "string"
							? req.headers["idempotency-key"]
							: undefined,
					body,
				})
				await handler(req, res)
			})()
		})
		const port = await listen(server)
		const origin = `http://127.0.0.1:${port}`
		originalFetch = globalThis.fetch
		globalThis.fetch = async (input, init) => {
			const path =
				typeof input === "string"
					? input
					: input instanceof URL
						? `${input.pathname}${input.search}`
						: input.url
			const relative = path.startsWith("http")
				? path.slice(new URL(path).origin.length)
				: path
			return originalFetch!(`${origin}${relative}`, init)
		}
	}

	test("listApiKeys parses rows and never sends Authorization", async () => {
		await start((_req, res) => {
			res.statusCode = 200
			res.setHeader("content-type", "application/json")
			res.end(
				JSON.stringify({
					keys: [
						{
							id: "key_1",
							prefix: "fp_test_abcd",
							label: "CI",
							createdAt: "2026-11-04T00:00:00.000Z",
							revokedAt: null,
						},
					],
				}),
			)
		})
		const result = await listApiKeys()
		assert.equal(result.keys[0]?.label, "CI")
		assert.equal(result.keys[0]?.prefix, "fp_test_abcd")
		assert.equal(seen[0]?.url, "/v1/api-keys")
		assert.equal(seen[0]?.authorization, undefined)
	})

	test("createApiKey returns the one-time secret with an Idempotency-Key", async () => {
		await start((_req, res) => {
			res.statusCode = 201
			res.setHeader("content-type", "application/json")
			res.end(
				JSON.stringify({
					id: "key_2",
					prefix: "fp_test_efgh",
					label: "Laptop",
					createdAt: "2026-11-04T01:00:00.000Z",
					revokedAt: null,
					key: "fp_test_efgh_secret_once",
				}),
			)
		})
		const created = await createApiKey({ label: "Laptop" })
		assert.equal(created.key, "fp_test_efgh_secret_once")
		assert.equal(seen[0]?.method, "POST")
		assert.ok(seen[0]?.idempotency?.startsWith("api-key-"))
		assert.deepEqual(JSON.parse(seen[0]?.body ?? "{}"), { label: "Laptop" })
	})

	test("revokeApiKey posts to /revoke", async () => {
		await start((_req, res) => {
			res.statusCode = 200
			res.setHeader("content-type", "application/json")
			res.end(
				JSON.stringify({
					id: "key_1",
					prefix: "fp_test_abcd",
					label: "CI",
					createdAt: "2026-11-04T00:00:00.000Z",
					revokedAt: "2026-11-04T02:00:00.000Z",
				}),
			)
		})
		const row = await revokeApiKey("key_1")
		assert.equal(row.revokedAt, "2026-11-04T02:00:00.000Z")
		assert.equal(seen[0]?.url, "/v1/api-keys/key_1/revoke")
		assert.equal(seen[0]?.method, "POST")
	})

	test("listApiKeys surfaces 401 as auth_required", async () => {
		await start((_req, res) => {
			res.statusCode = 401
			res.setHeader("content-type", "application/json")
			res.end(
				JSON.stringify({
					code: "unauthorized",
					message: "This operation needs a signed-in customer session",
				}),
			)
		})
		await assert.rejects(
			() => listApiKeys(),
			(error: unknown) => {
				assert.ok(error instanceof ApiError)
				assert.equal(error.code, "auth_required")
				return true
			},
		)
	})
})
