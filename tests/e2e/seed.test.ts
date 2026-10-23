import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { loadFixtures } from "../../scripts/demo/lib/fixtures.ts"
import { HttpClient } from "../../scripts/demo/lib/http.ts"
import { BlockedError } from "../../scripts/demo/lib/report.ts"
import { runSeed } from "../../scripts/seed/lib/runner.ts"

// These tests use a loopback stub, not the integrated API. They prove the seed/reset runner only
// sends contracted requests, and that a missing endpoint route or schema is BLOCKED rather than
// replaced with an invented body.

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
			if (req.method === "GET" && req.url === "/v1/endpoints") {
				json(status.endpoints ?? 404, {
					code: "not_found",
					message: "No such route",
				})
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
	it("resets with A0's empty body and creates no fixtures for the reset command", async () => {
		stub = await openStub({ reset: 200 })
		const http = new HttpClient(stub.base, "test-key", 5_000)
		const outcome = await runSeed(http, loadFixtures(), { command: "reset" })
		expect(outcome.resetStatus).toBe(200)
		expect(outcome.recipients).toEqual([])
		expect(stub.seen).toHaveLength(1)
		expect(stub.seen[0]).toMatchObject({
			method: "POST",
			path: "/v1/sandbox/reset",
			body: {},
			idempotencyKey: "seed:reset",
		})
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

	it("creates the neutral recipients, then blocks when endpoints are absent", async () => {
		stub = await openStub({ reset: 200, endpoints: 404 })
		const http = new HttpClient(stub.base, "test-key", 5_000)
		const fixtures = loadFixtures()
		await expect(runSeed(http, fixtures)).rejects.toThrow(/v1\/endpoints/)

		const resets = stub.seen.filter((r) => r.path === "/v1/sandbox/reset")
		expect(resets).toHaveLength(1)
		const recipients = stub.seen.filter((r) => r.path === "/v1/recipients")
		expect(recipients).toHaveLength(fixtures.workers.length)
		for (const [index, worker] of fixtures.workers.entries()) {
			expect(recipients[index]).toMatchObject({
				method: "POST",
				body: { name: worker.name, kind: worker.kind, country: worker.country },
				idempotencyKey: `seed:recipient:${worker.ref}`,
			})
		}
		expect(stub.seen.at(-1)).toMatchObject({
			method: "GET",
			path: "/v1/endpoints",
		})
	})

	it("does not invent endpoint fields when the route is mounted but A0 has no schema", async () => {
		stub = await openStub({ reset: 200, endpoints: 200 })
		const http = new HttpClient(stub.base, "test-key", 5_000)
		await expect(runSeed(http, loadFixtures())).rejects.toThrow(/schema/)
		const requests = stub.seen.map((r) => `${r.method} ${r.path}`)
		expect(requests).not.toContain("POST /v1/endpoints")
		expect(requests.at(-1)).toBe("GET /v1/endpoints")
	})
})
