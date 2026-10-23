import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import {
	endpointWireFields,
	loadFixtures,
} from "../../scripts/demo/lib/fixtures.ts"
import { HttpClient } from "../../scripts/demo/lib/http.ts"
import { BlockedError } from "../../scripts/demo/lib/report.ts"
import { runSeed } from "../../scripts/seed/lib/runner.ts"

// These tests use a loopback stub, not the integrated API. They prove the seed/reset runner sends
// only contracted requests and that a missing route is BLOCKED rather than replaced with an
// invented body.

interface Seen {
	method: string
	path: string
	body: unknown
	idempotencyKey?: string
}

interface Stub {
	base: string
	seen: Seen[]
	close(): Promise<void>
}

const openStub = async (status: {
	reset?: number
	endpoints?: number
	recipients?: number
}): Promise<Stub> => {
	const seen: Seen[] = []
	let recipient = 0
	let endpoint = 0
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = []
		req.on("data", (chunk: Buffer) => chunks.push(chunk))
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8")
			const body = raw ? JSON.parse(raw) : undefined
			seen.push({
				method: req.method ?? "",
				path: req.url ?? "",
				body,
				idempotencyKey: req.headers["idempotency-key"] as string | undefined,
			})
			const json = (code: number, payload: unknown) => {
				res.writeHead(code, { "content-type": "application/json" })
				res.end(JSON.stringify(payload))
			}

			if (req.method === "POST" && req.url === "/v1/sandbox/reset") {
				json(status.reset ?? 200, { status: "ok" })
				return
			}
			if (req.method === "POST" && req.url === "/v1/recipients") {
				recipient += 1
				json(status.recipients ?? 201, {
					id: `rcp_test_${recipient}`,
					name: (body as { name?: string }).name,
					kind: (body as { kind?: string }).kind,
					country: (body as { country?: string }).country,
					createdAt: new Date().toISOString(),
				})
				return
			}
			if (req.method === "POST" && req.url === "/v1/endpoints") {
				if (status.endpoints === 404) {
					json(404, { code: "not_found", message: "No such route" })
					return
				}
				endpoint += 1
				json(status.endpoints ?? 201, {
					...body,
					id: `end_test_${endpoint}`,
					organizationId: "org_test",
					createdAt: new Date().toISOString(),
				})
				return
			}
			json(404, { code: "not_found", message: "No such route" })
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	if (address === null || typeof address === "string")
		throw new Error("no stub port")
	return {
		base: `http://127.0.0.1:${address.port}`,
		seen,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	}
}

let stub: Stub | undefined
afterEach(async () => {
	await stub?.close()
	stub = undefined
})

describe("seed/reset runner", () => {
	it("resets with A0's empty body, without an idempotency key, and creates no fixtures", async () => {
		stub = await openStub({ reset: 200 })
		const http = new HttpClient(stub.base, "test-key", 5_000)
		const outcome = await runSeed(http, loadFixtures(), { command: "reset" })
		expect(outcome.resetStatus).toBe(200)
		expect(outcome.recipients).toEqual([])
		expect(outcome.endpoints).toEqual([])
		expect(stub.seen).toHaveLength(1)
		expect(stub.seen[0]).toMatchObject({
			method: "POST",
			path: "/v1/sandbox/reset",
			body: {},
		})
		// A key would make the API replay its cached 200 and skip the wipe.
		expect(stub.seen[0].idempotencyKey).toBeUndefined()
	})

	it("blocks before creating fixtures when /v1/sandbox/reset is not mounted", async () => {
		stub = await openStub({ reset: 404 })
		const http = new HttpClient(stub.base, "test-key", 5_000)
		const error = await runSeed(http, loadFixtures()).catch(
			(caught: unknown) => caught,
		)
		expect(error).toBeInstanceOf(BlockedError)
		expect(error).toMatchObject({
			blockers: [expect.objectContaining({ owner: "Csaba (CC3b)" })],
		})
		expect(stub.seen).toHaveLength(1)
		expect(stub.seen[0].path).toBe("/v1/sandbox/reset")
	})

	it("creates every neutral recipient and endpoint with contracted fields", async () => {
		stub = await openStub({ reset: 200, endpoints: 201 })
		const http = new HttpClient(stub.base, "test-key", 5_000)
		const fixtures = loadFixtures()
		const outcome = await runSeed(http, fixtures)

		expect(outcome.recipients).toHaveLength(fixtures.workers.length)
		const expectedEndpoints = fixtures.workers.flatMap((worker) =>
			worker.endpoints.map((endpoint) => ({ worker, endpoint })),
		)
		expect(outcome.endpoints).toHaveLength(expectedEndpoints.length)

		const recipientRequests = stub.seen.filter(
			(r) => r.path === "/v1/recipients",
		)
		expect(recipientRequests).toHaveLength(fixtures.workers.length)
		for (const [index, worker] of fixtures.workers.entries()) {
			expect(recipientRequests[index]).toMatchObject({
				method: "POST",
				body: { name: worker.name, kind: worker.kind, country: worker.country },
				idempotencyKey: `seed:recipient:${worker.ref}`,
			})
		}

		const endpointRequests = stub.seen.filter((r) => r.path === "/v1/endpoints")
		expect(endpointRequests).toHaveLength(expectedEndpoints.length)
		for (const [index, item] of expectedEndpoints.entries()) {
			const wire = endpointWireFields(item.endpoint)
			const recipient = outcome.recipients.find(
				(r) => r.ref === item.worker.ref,
			)
			expect(endpointRequests[index]).toMatchObject({
				method: "POST",
				body: {
					recipientId: recipient?.id,
					type: item.endpoint.type,
					country: wire.country,
					currency: item.endpoint.currency,
					network: wire.network,
					details: wire.details,
					simulated: true,
				},
				idempotencyKey: `seed:endpoint:${item.worker.ref}:${item.endpoint.ref}`,
			})
		}

		// A crypto endpoint uses an empty country and `stellar`; fiat keeps its country.
		const crypto = expectedEndpoints.find(
			(item) => item.endpoint.type === "crypto_wallet",
		)
		if (!crypto) throw new Error("fixture is missing a crypto endpoint")
		const cryptoRequest = endpointRequests.find(
			(request) => (request.body as { type?: string }).type === "crypto_wallet",
		)
		expect(cryptoRequest?.body).toMatchObject({
			country: "",
			network: "stellar",
			details: { address: crypto.endpoint.detailsRef },
		})
	})

	it("blocks when the endpoint route is absent and sends no fallback fields", async () => {
		stub = await openStub({ reset: 200, endpoints: 404 })
		const http = new HttpClient(stub.base, "test-key", 5_000)
		const error = await runSeed(http, loadFixtures()).catch(
			(caught: unknown) => caught,
		)
		expect(error).toBeInstanceOf(BlockedError)
		expect(error).toMatchObject({
			blockers: [expect.objectContaining({ owner: "Csaba (CC3b)" })],
		})
		const endpointRequests = stub.seen.filter((r) => r.path === "/v1/endpoints")
		expect(endpointRequests).toHaveLength(1)
		expect(
			stub.seen.some((r) => r.method === "GET" && r.path.includes("endpoints")),
		).toBe(false)
	})
})
