import {
	expectEventTypes,
	expectLegKinds,
	expectNoEvent,
	expectNoSettle,
	expectPaid,
	expectRail,
	expectReasons,
	fail,
} from "./lib/assertions.ts"
import { endpointOf, flowOf, workerOf } from "./lib/fixtures.ts"
import { ROUTES } from "./lib/routes.ts"
import { execute } from "./lib/script.ts"
import { setUpWorker } from "./lib/setup.ts"
import { waitForBatch, waitForPayment } from "./lib/wait.ts"
import type { PaymentView } from "./lib/types.ts"
import type { Df1Expectation } from "./lib/fixtures.ts"

// DF1: one JSON batch pays Worker A (PH e-wallet), Worker B (BR bank) and Worker C (US domestic
// bank). The US row must take the domestic rail with a reason, and only the cross-border rows
// carry a settle leg.

const runId = Date.now().toString(36)

await execute(
	{ id: "DF1", title: "Three-worker JSON batch", needs: ROUTES.df1 },
	async ({ api, fixtures, flow }) => {
		const spec = flowOf(fixtures, "df1")
		const rows = spec.rows
		if (!rows || rows.length !== 3) fail("df1 fixture must carry three rows")
		const expected = fixtures.expectations.df1

		const prepared = []
		for (const row of rows) {
			const worker = workerOf(fixtures, row.workerRef)
			const endpoint = endpointOf(worker, row.endpointRef)
			const handles = await setUpWorker(api, flow, worker, endpoint)
			prepared.push({ row, handles, endpoint })
		}

		flow.route("POST", "/v1/batches", "3 rows, profile batch")
		const created = await api.createBatch(
			prepared.map((p, index) => ({
				recipientId: p.handles.recipient.id,
				endpointId: p.handles.endpoint.id,
				amount: p.row.send,
				externalId: `df1-${runId}-${index + 1}`,
				profile: "batch" as const,
			})),
		)
		if (created.paymentIds.length !== 3) {
			fail(
				`batch ${created.id} has ${created.paymentIds.length} payments, expected 3`,
			)
		}
		flow.check(`batch ${created.id} returned three payment ids`)
		if (created.totals === undefined) fail(`batch ${created.id} has no totals`)

		const payments: PaymentView[] = []
		for (const [index, paymentId] of created.paymentIds.entries()) {
			flow.route("POST", `/v1/payments/${paymentId}/fund`)
			await api.fund(paymentId)
			const payment = await waitForPayment(api, paymentId)
			expectPaid(payment)
			const p = prepared[index]
			const corridor = corridorKey(p.endpoint.country, p.endpoint.type)
			assertCorridor(payment, expected[corridor], corridor)
			flow.legs(`${p.row.workerRef}`, payment.legs)
			flow.check(`${p.row.workerRef} paid via ${expected[corridor].payoutRail}`)
			payments.push(payment)
		}

		const batch = await waitForBatch(api, created.id)
		if (!["paid", "completed"].includes(batch.status.toLowerCase())) {
			fail(`batch ${batch.id} finished as ${batch.status}`)
		}
		flow.check("batch reported all rows settled")

		const usIndex = prepared.findIndex((p) => p.endpoint.country === "US")
		const usPayment = payments[usIndex]
		const usReasons = batch.rows?.find(
			(row) => row.paymentId === usPayment.id,
		)?.reasons
		if (!usReasons) fail("US domestic batch row has no route reasons")
		expectReasons(
			usReasons,
			[/sim_bank_us_ach|ACH/i, /domestic|same country/i],
			"US row",
		)
		flow.check("domestic rail chosen with a reason")

		for (const [index, payment] of payments.entries()) {
			const country = prepared[index].endpoint.country
			const events = payment.events ?? (await api.events(payment.id))
			const types = events.map((event) => event.type)
			if (country === "US") {
				expectNoEvent(types, "payment.onchain")
				flow.check("US payment has no on-chain event")
			} else {
				expectEventTypes(
					types,
					["payment.onchain", "payment.paid"],
					`${country} payment`,
				)
				flow.check(`${country} payment emitted on-chain and paid events`)
			}
		}
	},
)

function corridorKey(country: string, type: string): keyof Df1Expectation {
	if (country === "US") return "us"
	if (country === "BR") return "br"
	if (country === "PH" && type === "ewallet") return "ph"
	throw new Error(`fixture row ${country}/${type} has no DF1 expectation`)
}

function assertCorridor(
	payment: PaymentView,
	expected: Df1Expectation[keyof Df1Expectation],
	where: string,
): void {
	expectLegKinds(payment.legs, expected.legs, where)
	if (expected.domesticRail) {
		expectNoSettle(payment.legs, where)
		expectRail(payment.legs, "collect", expected.collectRail!, where)
		expectRail(payment.legs, "payout", expected.payoutRail!, where)
		return
	}
	expectRail(payment.legs, "settle", expected.settleRail!, where)
	expectRail(payment.legs, "payout", expected.payoutRail!, where)
}
