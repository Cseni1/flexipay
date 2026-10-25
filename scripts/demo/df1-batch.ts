import {
	expectEventTypes,
	expectFrozenAccounting,
	expectLegKinds,
	expectNoEvent,
	expectNoSettle,
	expectPaid,
	expectQuoteFeeMode,
	expectRail,
	fail,
} from "./lib/assertions.ts"
import { A0_CONTRACT_ANSWERS } from "./lib/a0-answers.ts"
import { maskAddress } from "./lib/env.ts"
import { endpointOf, flowOf, workerOf } from "./lib/fixtures.ts"
import { BlockedError } from "./lib/report.ts"
import { ROUTES } from "./lib/routes.ts"
import { execute } from "./lib/script.ts"
import { setUpWorker } from "./lib/setup.ts"
import {
	readVaultPayoutByExternal,
	vaultExternalId,
	verifyVaultPayment,
} from "./lib/stellar-proof.ts"
import { waitForBatch, waitForPayment } from "./lib/wait.ts"
import type { PaymentView, QuoteView } from "./lib/types.ts"
import type { Df1Expectation } from "./lib/fixtures.ts"

// DF1: one JSON batch pays Worker A (PH e-wallet), Worker B (BR bank) and Worker C (US domestic
// bank). The US row must take the domestic rail with a reason, and only the cross-border rows
// carry a settle leg.

const runId = Date.now().toString(36)

await execute(
	{ id: "DF1", title: "Three-worker JSON batch", needs: ROUTES.df1 },
	async ({ api, env, fixtures, flow }) => {
		const spec = flowOf(fixtures, "df1")
		const rows = spec.rows
		if (!rows || rows.length !== 3) fail("df1 fixture must carry three rows")
		const expected = fixtures.expectations.df1

		const prepared: Array<{
			row: (typeof rows)[number]
			handles: Awaited<ReturnType<typeof setUpWorker>>
			endpoint: Awaited<ReturnType<typeof endpointOf>>
			quote: QuoteView
		}> = []
		for (const row of rows) {
			const worker = workerOf(fixtures, row.workerRef)
			const endpoint = endpointOf(worker, row.endpointRef)
			const handles = await setUpWorker(api, flow, worker, endpoint)
			flow.route(
				"POST",
				"/v1/quotes",
				`${row.workerRef} frozen H3 reference quote`,
			)
			const quote = await api.quote({
				destination: {
					type: endpoint.type,
					country: endpoint.country,
					currency: endpoint.currency,
					recipientKind: worker.kind,
				},
				amount: row.send,
				amountSide: "send",
				feeMode: spec.feeMode,
				policy: "cheapest",
			})
			expectQuoteFeeMode(quote, spec.feeMode, `${row.workerRef} quote`)
			prepared.push({ row, handles, endpoint, quote })
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
			spec.feeMode,
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
			expectFrozenAccounting(p.quote, payment, p.row.workerRef)
			flow.legs(`${p.row.workerRef}`, payment.legs)
			flow.check(`${p.row.workerRef} paid via ${expected[corridor].payoutRail}`)
			payments.push(payment)
		}

		const batch = await waitForBatch(api, created.id)
		if (!["paid", "completed"].includes(batch.status.toLowerCase())) {
			fail(`batch ${batch.id} finished as ${batch.status}`)
		}
		flow.check("batch reported all rows settled")

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

		// A0: reasons live on Quote, not on batch rows. The per-row reference quotes above
		// carry the domestic explanation without inventing batch fields (see a0-answers.ts).
		const usPrepared = prepared.find((p) => p.endpoint.country === "US")
		if (!usPrepared) fail("DF1 fixture missing US row")
		if (usPrepared.quote.reasons.length === 0) {
			fail("US domestic quote has empty reasons; expected a route explanation")
		}
		flow.check(
			`US domestic reasons from Quote (${A0_CONTRACT_ANSWERS.batchReasons})`,
		)

		// H3: decode both vault transactions for each cross-border row; prove the US row
		// has no lock/release at all. The same frozen reference quote supplies P and fee.
		if (env.settlement === "stellar") {
			if (
				!env.payoutVaultId ||
				!env.assetContractId ||
				!env.recipientAddress ||
				!env.stellarRpcUrl ||
				!env.stellarNetworkPassphrase
			) {
				throw new BlockedError([
					{
						what: "H3 requires the public vault id, asset id, Worker A address, RPC and passphrase",
						owner: "caller / Csaba (integration)",
					},
				])
			}
			if (!env.payerAddress) {
				throw new BlockedError([
					{
						what: "H3 domestic negative proof requires FP_PAYER_DEMO_ADDRESS",
						owner: "caller / Csaba (integration)",
					},
				])
			}
			let crossBorderLocks = 0
			for (const [index, payment] of payments.entries()) {
				const p = prepared[index]
				if (p.endpoint.country === "US") {
					const payoutId = await readVaultPayoutByExternal({
						vaultContractId: env.payoutVaultId,
						payerAddress: env.payerAddress,
						externalIdHex: vaultExternalId(payment.id),
						rpcUrl: env.stellarRpcUrl,
						networkPassphrase: env.stellarNetworkPassphrase,
						timeoutMs: env.timeoutMs,
					})
					if (payoutId !== undefined) {
						fail(
							`US domestic payment ${payment.id} unexpectedly locked payout ${payoutId}`,
						)
					}
					flow.check("US domestic payment has no vault payout")
					continue
				}
				const proof = await verifyVaultPayment({
					payment,
					quote: p.quote,
					recipientAddress: env.recipientAddress,
					vaultContractId: env.payoutVaultId,
					expectedAssetContractId: env.assetContractId,
					rpcUrl: env.stellarRpcUrl,
					networkPassphrase: env.stellarNetworkPassphrase,
					timeoutMs: env.timeoutMs,
				})
				crossBorderLocks += 1
				console.log(
					`chain  ${p.row.workerRef} lock ${proof.lockHash} release ${proof.hash} payout ${proof.payoutId}`,
				)
				console.log(
					`vault  ${proof.contractId} asset ${proof.assetContractId} recipient ${maskAddress(proof.recipient)}`,
				)
				console.log(
					`amount principal ${proof.principal} fee ${proof.fee} net ${proof.net} feeMode ${proof.feeMode} bps ${proof.vaultFeeBps}`,
				)
				flow.check(
					`${p.row.workerRef} lock/release decode to the same vault, asset, payment and payout`,
				)
			}
			if (crossBorderLocks !== 2) {
				fail(`DF1 produced ${crossBorderLocks} vault locks, expected 2`)
			}
			flow.check("batch produced exactly two vault locks and no domestic lock")
		}

		flow.note(
			`batch ${batch.id} status ${batch.status}; reasons via quote, not batch row`,
		)
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
