import {
	expectEventTypes,
	expectKinds,
	expectNoEvent,
	expectNoSettle,
	expectPaid,
	expectRail,
	expectReasons,
	expectSimulated,
	fail,
} from "./lib/assertions.ts"
import { endpointOf, flowOf, workerOf } from "./lib/fixtures.ts"
import { ApiRejection } from "./lib/rejection.ts"
import { ROUTES } from "./lib/routes.ts"
import { execute } from "./lib/script.ts"
import { setUpWorker } from "./lib/setup.ts"
import { waitForPayment } from "./lib/wait.ts"

// DF5: a ZA company is paid to its bank account. The quote must choose the bank route with no
// settlement leg and must explain the crypto exclusion by recipient kind; asking for a crypto
// destination for that company is refused, with the same explanation.

const runId = Date.now().toString(36)

await execute(
	{ id: "DF5", title: "South Africa company, bank route", needs: ROUTES.df5 },
	async ({ api, fixtures, flow }) => {
		const spec = flowOf(fixtures, "df5")
		const expected = fixtures.expectations.df5
		const worker = workerOf(fixtures, spec.workerRef)
		const endpoint = endpointOf(worker, spec.endpointRef)
		if (worker.kind !== "company") fail("df5 fixture must be a company")

		const destination = {
			type: endpoint.type,
			country: endpoint.country,
			currency: endpoint.currency,
			recipientKind: worker.kind,
		}

		flow.route("POST", "/v1/quotes", "ZA company, bank account")
		const quote = await api.quote({
			destination,
			amount: spec.send,
			amountSide: "send",
			policy: "cheapest",
		})
		expectKinds(
			quote.route.map((leg) => leg.kind),
			expected.legs,
			"quote.route",
		)
		expectReasons(quote.reasons, [/crypto/i, /compan(y|ies)/i], "quote.reasons")
		expectSimulated(quote.simulated, "quote")
		flow.check("bank route chosen with the crypto exclusion explained")

		flow.route(
			"POST",
			"/v1/quotes",
			"ZA company, crypto wallet (must be refused)",
		)
		try {
			await api.quote({
				destination: {
					...destination,
					type: "crypto_wallet",
					currency: "USDC",
				},
				amount: spec.send,
				amountSide: "send",
				policy: "cheapest",
			})
			fail("a ZA company crypto quote was accepted")
		} catch (error) {
			if (!(error instanceof ApiRejection)) throw error
			if (error.status !== 422)
				fail(`crypto quote was refused with HTTP ${error.status}, expected 422`)
			expectReasons(
				error.reasons,
				[/crypto/i, /compan(y|ies)/i],
				"refusal reasons",
			)
		}
		flow.check("crypto quote refused with a recipient-kind reason")

		const handles = await setUpWorker(api, flow, worker, endpoint)
		flow.route(
			"POST",
			"/v1/payments",
			"direct delivery from the eligible quote",
		)
		const created = await api.createPayment({
			quoteId: quote.id,
			recipientId: handles.recipient.id,
			endpointId: handles.endpoint.id,
			externalId: `df5-${runId}`,
			delivery: "direct",
			profile: "one_off",
		})
		flow.route("POST", `/v1/payments/${created.payment.id}/fund`)
		await api.fund(created.payment.id)
		const payment = await waitForPayment(api, created.payment.id)
		expectPaid(payment)
		expectNoSettle(payment.legs, "payment.legs")
		expectKinds(
			payment.legs.map((leg) => leg.kind),
			expected.legs,
			"payment.legs",
		)
		expectRail(payment.legs, "payout", expected.payoutRail!, "payment.legs")
		flow.legs("payment", payment.legs)
		flow.check("ZA payment paid over the bank route with no settlement leg")

		const events = payment.events ?? (await api.events(payment.id))
		const types = events.map((event) => event.type)
		expectEventTypes(types, ["payment.paid"], "payment events")
		expectNoEvent(types, "payment.onchain")
		flow.check("no on-chain event on a route without settlement")
	},
)
