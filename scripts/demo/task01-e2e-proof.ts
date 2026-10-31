/**
 * Task 01 evidence: real API business path + Vite proxy path (no browser).
 * Local mock settlement only. Prints no API key material.
 *
 *   node scripts/demo/task01-e2e-proof.ts
 */
import assert from "node:assert/strict"
import { createServer as createHttpServer } from "node:http"
import { type AddressInfo } from "node:net"
import { createApiProxyMiddleware } from "../../apps/web/vite.proxy.ts"
import { auth, startTestServer } from "../../apps/api/test/helpers.ts"

const listen = (server: ReturnType<typeof createHttpServer>): Promise<number> =>
	new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => {
			resolve((server.address() as AddressInfo).port)
		})
	})

const json = async (response: Response): Promise<unknown> => response.json()

const main = async (): Promise<void> => {
	const api = await startTestServer()
	const { key } = await api.newOrg("Task01 Demo Platform")

	try {
		const health = await fetch(`${api.base}/healthz`)
		assert.equal(health.status, 200)
		assert.deepEqual(await json(health), { status: "ok" })

		const corridors = await fetch(`${api.base}/v1/corridors`, {
			headers: auth(key),
		})
		assert.equal(corridors.status, 200)
		const corridorBody = (await json(corridors)) as {
			corridors: { to: { country: string } }[]
		}
		assert.ok(corridorBody.corridors.length >= 4)

		const created = await fetch(`${api.base}/v1/recipients`, {
			method: "POST",
			headers: auth(key, { "idempotency-key": "task01-rcp-1" }),
			body: JSON.stringify({
				name: "Worker Task01",
				kind: "individual",
				country: "PH",
			}),
		})
		assert.equal(created.status, 201)
		const recipient = (await json(created)) as { id: string; name: string }
		assert.equal(recipient.name, "Worker Task01")

		const listed = await fetch(`${api.base}/v1/recipients`, {
			headers: auth(key),
		})
		assert.equal(listed.status, 200)
		const listBody = (await json(listed)) as {
			recipients: { id: string }[]
		}
		assert.ok(listBody.recipients.some((row) => row.id === recipient.id))

		const quoteRes = await fetch(`${api.base}/v1/quotes`, {
			method: "POST",
			headers: auth(key, { "idempotency-key": "task01-quote-1" }),
			body: JSON.stringify({
				source: { type: "bank_account", currency: "USD", country: "US" },
				destination: {
					type: "ewallet",
					currency: "PHP",
					country: "PH",
					recipientKind: "individual",
				},
				amount: {
					side: "send",
					value: { amount: "125000", currency: "USD" },
				},
				policy: "cheapest",
				feeMode: "PayerPays",
			}),
		})
		assert.equal(quoteRes.status, 201)
		const quote = (await json(quoteRes)) as {
			id: string
			simulated: boolean
		}
		assert.equal(quote.simulated, true)

		const paymentRes = await fetch(`${api.base}/v1/payments`, {
			method: "POST",
			headers: auth(key, { "idempotency-key": "task01-pay-1" }),
			body: JSON.stringify({
				quoteId: quote.id,
				recipientId: recipient.id,
				delivery: "claim_link",
				profile: "one_off",
			}),
		})
		assert.equal(paymentRes.status, 201)
		const payment = (await json(paymentRes)) as {
			id: string
			status: string
			claimLink: { url: string } | null
		}
		assert.ok(payment.claimLink?.url)

		const fundRes = await fetch(`${api.base}/v1/payments/${payment.id}/fund`, {
			method: "POST",
			headers: auth(key, { "idempotency-key": "task01-fund-1" }),
			body: "{}",
		})
		assert.equal(fundRes.status, 200)

		const detailRes = await fetch(`${api.base}/v1/payments/${payment.id}`, {
			headers: auth(key),
		})
		assert.equal(detailRes.status, 200)
		const detail = (await json(detailRes)) as { status: string }
		assert.equal(detail.status, "processing")

		const token = payment.claimLink!.url.split("/").pop()!
		const claimGet = await fetch(`${api.base}/v1/claims/${token}`)
		assert.equal(claimGet.status, 200)
		const claim = (await json(claimGet)) as {
			status: string
			paymentStatus: string
			allowedDestinationTypes: string[]
		}
		assert.equal(claim.status, "open")
		assert.equal(claim.paymentStatus, "processing")
		assert.ok(claim.allowedDestinationTypes.includes("ewallet"))

		const accept = await fetch(`${api.base}/v1/claims/${token}/accept`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "task01-accept-1",
			},
			body: JSON.stringify({
				endpoint: {
					type: "ewallet",
					country: "PH",
					currency: "PHP",
					network: null,
					details: { phoneNumber: "synthetic-ewallet-task01" },
					simulated: true,
				},
			}),
		})
		assert.equal(accept.status, 200)
		const accepted = (await json(accept)) as {
			paymentStatus: string
			claim: { status: string }
		}
		assert.equal(accepted.claim.status, "accepted")
		assert.equal(accepted.paymentStatus, "paid")

		// Same-origin proxy path used by apps/web (CCR-19): no browser Authorization.
		const proxy = createApiProxyMiddleware({
			target: api.base,
			apiKey: key,
		})
		const proxyServer = createHttpServer((req, res) => {
			proxy(req, res, () => {
				res.statusCode = 404
				res.end("not proxied")
			})
		})
		const proxyPort = await listen(proxyServer)
		const proxyBase = `http://127.0.0.1:${proxyPort}`
		try {
			const proxiedHealth = await fetch(`${proxyBase}/healthz`)
			assert.equal(proxiedHealth.status, 200)
			assert.deepEqual(await json(proxiedHealth), { status: "ok" })

			const proxiedCorridors = await fetch(`${proxyBase}/v1/corridors`)
			assert.equal(proxiedCorridors.status, 200)
			const proxiedBody = (await json(proxiedCorridors)) as {
				corridors: unknown[]
			}
			assert.equal(proxiedBody.corridors.length, corridorBody.corridors.length)

			const proxiedRecipients = await fetch(`${proxyBase}/v1/recipients`)
			assert.equal(proxiedRecipients.status, 200)
			const proxiedList = (await json(proxiedRecipients)) as {
				recipients: { id: string }[]
			}
			assert.ok(proxiedList.recipients.some((row) => row.id === recipient.id))
		} finally {
			await new Promise<void>((resolve) => proxyServer.close(() => resolve()))
		}

		console.log(
			JSON.stringify(
				{
					ok: true,
					evidence: {
						healthz: "ok",
						corridors: corridorBody.corridors.length,
						recipientId: recipient.id,
						paymentId: payment.id,
						paymentStatusAfterFund: detail.status,
						claimAcceptPaymentStatus: accepted.paymentStatus,
						proxyHealthz: "ok",
						proxyCorridors: "ok",
						proxyRecipientsPersisted: true,
					},
				},
				null,
				2,
			),
		)
	} finally {
		await api.stop()
	}
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
