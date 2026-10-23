import {
	expectKinds,
	expectRail,
	expectRouteRail,
	expectStatus,
	fail,
} from "./lib/assertions.ts"
import { endpointOf, flowOf, workerOf } from "./lib/fixtures.ts"
import { ROUTES } from "./lib/routes.ts"
import { execute } from "./lib/script.ts"
import { setUpWorker } from "./lib/setup.ts"
import { waitForPayment } from "./lib/wait.ts"
import type { EventView } from "./lib/types.ts"

// DF4: the BR payout provider is forced to fail. The engine must try the payout, retry it exactly
// once, and then refund through the settlement adapter and reverse the earlier legs. Two failed
// payout attempts and one refunded payment — never a third attempt and never a paid payment.

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
		const events: EventView[] = payment.events ?? (await api.events(payment.id))
		const types = events.map((event) => event.type)
		flow.legs("final", payment.legs)

		expectStatus(payment, ["refunded"], "payment")
		if (types.includes("payment.paid"))
			fail("a refunded payment also emitted payment.paid")
		flow.check("payment is refunded, not paid")

		const failures = types.filter((type) => type === "leg.failed").length
		if (failures !== expected.payoutAttempts) {
			fail(
				`timeline shows ${failures} leg.failed event(s), expected exactly ${expected.payoutAttempts}`,
			)
		}
		const payouts = payment.legs.filter((leg) => leg.kind === "payout")
		if (payouts.length === 0)
			fail("no payout attempt is visible on the payment")
		if (payouts.some((leg) => leg.status !== "failed")) {
			fail(
				`visible payout attempts are ${payouts.map((leg) => leg.status).join(", ")}, expected failed`,
			)
		}
		for (const [index, leg] of payouts.entries()) {
			const code = leg.error?.code
			if (!code) fail(`payout attempt ${index + 1} has no error code`)
			if (!["sandbox_forced_failure", "provider_down"].includes(code)) {
				fail(`payout attempt ${index + 1} failed with ${code}`)
			}
			if (leg.attempt !== undefined && leg.attempt !== index + 1) {
				fail(`payout attempt ${index + 1} reports attempt ${leg.attempt}`)
			}
		}
		if (payouts.length === 1) {
			if (payouts[0].attempt !== 2) {
				fail(
					"one payout leg is visible but it does not report attempt 2: the attempt timeline is not exposed (CC0/CC2 gap)",
				)
			}
		} else if (payouts.length !== expected.payoutAttempts) {
			fail(
				`payment shows ${payouts.length} payout attempts, expected ${expected.payoutAttempts}`,
			)
		}
		flow.check("exactly one retry: two failed payout attempts, no third")

		expectRail(payment.legs, "payout", expected.payoutRail!, "payment.legs")
		for (const kind of ["collect", "convert", "settle"] as const) {
			const legs = payment.legs.filter((leg) => leg.kind === kind)
			if (legs.length === 0) fail(`missing ${kind} leg on the refunded route`)
			if (legs.some((leg) => leg.status !== "reversed")) {
				fail(
					`${kind} legs are ${legs.map((leg) => leg.status).join(", ")}, expected reversed`,
				)
			}
		}
		flow.check("vault refund reversed collect, convert and settle")

		const refundAt = types.indexOf("payment.refunded")
		if (refundAt < 0) fail("timeline has no payment.refunded")
		if (types.lastIndexOf("leg.failed") > refundAt)
			fail("refund was recorded before the failed retry")
		flow.check("timeline shows two failures, then the refund")
	},
)
