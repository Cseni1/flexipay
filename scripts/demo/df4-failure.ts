import {
	expectKinds,
	expectRail,
	expectRouteRail,
	expectStatus,
	fail,
} from "./lib/assertions.ts"
import { assertExactlyOneRetryThenRefund } from "./lib/contract-gaps.ts"
import { A0_CONTRACT_ANSWERS } from "./lib/a0-answers.ts"
import { endpointOf, flowOf, workerOf } from "./lib/fixtures.ts"
import { ROUTES } from "./lib/routes.ts"
import { execute } from "./lib/script.ts"
import { setUpWorker } from "./lib/setup.ts"
import { waitForPayment } from "./lib/wait.ts"

// DF4: the BR payout provider is forced to fail. The documented terminal state is: payout failed,
// earlier collect/convert legs reversed, payment refunded. Proving "exactly one retry" and naming
// the vault refund need attempt/refund evidence that A0 has not defined, so the flow ends BLOCKED
// with that question instead of inventing a shape.

const runId = Date.now().toString(36)

await execute(
	{ id: "DF4", title: "Payout fails, one retry, refund", needs: ROUTES.df4 },
	async ({ api, fixtures, flow }) => {
		const spec = flowOf(fixtures, "df4")
		const expected = fixtures.expectations.df4
		const worker = workerOf(fixtures, spec.workerRef)
		const endpoint = endpointOf(worker, spec.endpointRef)
		const handles = await setUpWorker(api, flow, worker, endpoint)

		flow.route("POST", "/v1/quotes", "BR bank, send amount fixed")
		const quote = await api.quote({
			destination: {
				type: endpoint.type,
				country: endpoint.country,
				currency: endpoint.currency,
				recipientKind: worker.kind,
			},
			amount: spec.send,
			amountSide: "send",
			policy: "cheapest",
		})
		expectKinds(
			quote.route.map((leg) => leg.kind),
			expected.legs,
			"quote.route",
		)
		expectRouteRail(quote.route, "payout", expected.payoutRail!, "quote.route")

		flow.route("POST", "/v1/payments", "direct delivery from the quote")
		const created = await api.createPayment({
			quoteId: quote.id,
			recipientId: handles.recipient.id,
			endpointId: handles.endpoint.id,
			externalId: `df4-${runId}`,
			delivery: "direct",
			profile: "one_off",
		})

		flow.route(
			"POST",
			"/v1/sandbox/fail-next",
			`${expected.payoutRail} ×${expected.failCount}`,
		)
		await api.failNext(expected.payoutRail!, expected.failCount)
		flow.check(
			`next ${expected.failCount} ${expected.payoutRail} calls will fail`,
		)

		flow.route("POST", `/v1/payments/${created.payment.id}/fund`)
		await api.fund(created.payment.id)
		const payment = await waitForPayment(api, created.payment.id)
		const events = payment.events ?? (await api.events(payment.id))
		const types = events.map((event) => event.type)
		flow.legs("final", payment.legs)

		expectStatus(payment, ["refunded"], "payment")
		if (types.includes("payment.paid"))
			fail("a refunded payment also emitted payment.paid")
		flow.check("payment is refunded, not paid")

		const payouts = payment.legs.filter((leg) => leg.kind === "payout")
		if (payouts.length === 0) fail("no failed payout is visible on the payment")
		if (payouts.some((leg) => leg.status !== "failed")) {
			fail(
				`visible payout attempts are ${payouts.map((leg) => leg.status).join(", ")}, expected failed`,
			)
		}
		for (const [index, leg] of payouts.entries()) {
			const code = leg.error?.code
			if (!code) fail(`visible payout ${index + 1} has no error code`)
			if (!["sandbox_forced_failure", "provider_down"].includes(code)) {
				fail(`visible payout ${index + 1} failed with ${code}`)
			}
		}
		expectRail(payment.legs, "payout", expected.payoutRail!, "payment.legs")
		flow.check("payout failed on the routed provider")

		// ARCHITECTURE §7 reverses the earlier legs. The settle leg is not asserted: neither the
		// architecture nor SCENARIOS.md fixes its status after a vault refund.
		for (const kind of ["collect", "convert"] as const) {
			const legs = payment.legs.filter((leg) => leg.kind === kind)
			if (legs.length === 0) fail(`missing ${kind} leg on the refunded route`)
			if (legs.some((leg) => leg.status !== "reversed")) {
				fail(
					`${kind} legs are ${legs.map((leg) => leg.status).join(", ")}, expected reversed`,
				)
			}
		}
		flow.check(
			"collect and convert legs reversed; settle status is not asserted",
		)

		if (!types.includes("leg.failed")) fail("timeline has no leg.failed event")
		if (!types.includes("payment.refunded"))
			fail("timeline has no payment.refunded")
		flow.check("timeline shows a failed leg and the refund")

		assertExactlyOneRetryThenRefund(payment, events)
		flow.check(`exactly one retry then refund (${A0_CONTRACT_ANSWERS.payoutAttempts})`)
		flow.note(A0_CONTRACT_ANSWERS.vaultRefund)
	},
)
