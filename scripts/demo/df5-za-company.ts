import {
	expectEventTypes,
	expectKinds,
	expectNoEvent,
	expectNoSettle,
	expectPaid,
	expectQuoteFeeMode,
	expectRail,
	expectReasonExplaining,
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
// settlement leg and explain the crypto exclusion; asking for a crypto destination for that
// company is refused with the same explanation. The exact sentence stays free, but the reason
// must name crypto and the company recipient kind: non-empty prose alone is not acceptance.

const EXCLUSION_REASONS = [
	/crypto/i,
	/compan/i,
	/not allowed|not eligible|excluded|exclusion|cannot|unavailable|not available|does not support|not supported|only .*bank/i,
] as const

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
			feeMode: spec.feeMode,
			policy: "cheapest",
		})
		expectQuoteFeeMode(quote, spec.feeMode)
		expectKinds(
			quote.route.map((leg) => leg.kind),
			expected.legs,
			"quote.route",
		)
		expectReasonExplaining(
			quote.reasons,
			EXCLUSION_REASONS,
			"ZA bank quote reasons",
		)
		expectSimulated(quote.simulated, "quote")
		flow.check("bank route reason explains the crypto exclusion for a company")

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
				feeMode: spec.feeMode,
				policy: "cheapest",
			})
			fail("a ZA company crypto quote was accepted")
		} catch (error) {
			if (!(error instanceof ApiRejection)) throw error
			if (error.status !== 422)
				fail(`crypto quote was refused with HTTP ${error.status}, expected 422`)
			expectReasonExplaining(
				error.reasons,
				EXCLUSION_REASONS,
				"ZA crypto quote refusal reasons",
			)
		}
		flow.check(
			"crypto quote refused with an explanation naming crypto and company",
		)
		flow.note(
			"exact prose remains free; the reason must name crypto and the recipient kind",
		)

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
		if (payment.legs.at(-1)?.kind !== "payout")
			fail("a paid direct payment must end at payout")
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
