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
	createRecipient,
	getHealth,
	listCorridors,
	listRecipients,
} from "./client.ts"

interface Seen {
	method: string | undefined
	url: string | undefined
	authorization: string | undefined
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

const readBody = (req: IncomingMessage): Promise<string> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
		req.on("error", reject)
	})

describe("typed API client (mocked same-origin fetch)", () => {
	let server: Server | undefined
	let originalFetch: typeof fetch | undefined
	const seen: Seen[] = []

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

	test("getHealth parses /healthz and never sends Authorization", async () => {
		await start((_req, res) => {
			res.statusCode = 200
			res.setHeader("content-type", "application/json")
			res.end(JSON.stringify({ status: "ok" }))
		})

		const health = await getHealth()
		assert.deepEqual(health, { status: "ok" })
		assert.equal(seen[0]?.url, "/healthz")
		assert.equal(seen[0]?.authorization, undefined)
	})

	test("listCorridors and listRecipients validate API payloads", async () => {
		await start((req, res) => {
			res.statusCode = 200
			res.setHeader("content-type", "application/json")
			if (req.url === "/v1/corridors") {
				res.end(
					JSON.stringify({
						corridors: [
							{
								from: { country: "US", currency: "USD" },
								to: { country: "PH", currency: "PHP" },
								allowedDestinationTypes: ["bank_account", "crypto_wallet"],
								recipientKinds: ["individual"],
								regulationNote: "note",
								simulated: true,
							},
						],
					}),
				)
				return
			}
			res.end(
				JSON.stringify({
					recipients: [
						{
							id: "rcp_1",
							name: "Worker A",
							kind: "individual",
							country: "PH",
							createdAt: "2026-10-31T00:00:00.000Z",
						},
					],
				}),
			)
		})

		const corridors = await listCorridors()
		const recipients = await listRecipients()
		assert.equal(corridors.corridors[0]?.to.country, "PH")
		assert.equal(recipients.recipients[0]?.id, "rcp_1")
		assert.equal(
			seen.some((entry) => entry.authorization),
			false,
		)
	})

	test("createRecipient surfaces structured API errors", async () => {
		await start((_req, res) => {
			res.statusCode = 401
			res.setHeader("content-type", "application/json")
			res.end(
				JSON.stringify({
					code: "unauthorized",
					message: "Unknown or revoked API key",
				}),
			)
		})

		await assert.rejects(
			() =>
				createRecipient(
					{ name: "A", kind: "individual", country: "PH" },
					"idem-1",
				),
			(error: unknown) => {
				assert.ok(error instanceof ApiError)
				assert.equal(error.status, 401)
				assert.equal(error.code, "auth_required")
				return true
			},
		)
	})

	test("rejects responses that do not match the contract", async () => {
		await start((_req, res) => {
			res.statusCode = 200
			res.setHeader("content-type", "application/json")
			res.end(JSON.stringify({ status: "fine" }))
		})

		await assert.rejects(
			() => getHealth(),
			(error: unknown) => {
				assert.ok(error instanceof ApiError)
				assert.equal(error.code, "invalid_response")
				return true
			},
		)
	})
})
