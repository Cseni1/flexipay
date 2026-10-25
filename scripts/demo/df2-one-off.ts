import {
	expectEventTypes,
	expectFrozenAccounting,
	expectFutureWindow,
	expectKinds,
	expectPaid,
	expectQuoteFeeMode,
	expectRail,
	expectRouteRail,
	expectSimulated,
	fail,
} from "./lib/assertions.ts"
import { maskAddress } from "./lib/env.ts"
import { endpointOf, flowOf, workerOf } from "./lib/fixtures.ts"
import { BlockedError } from "./lib/report.ts"
import { ROUTES } from "./lib/routes.ts"
import { execute } from "./lib/script.ts"
import { setUpWorker } from "./lib/setup.ts"
import { verifyVaultPayment } from "./lib/stellar-proof.ts"
import { waitForPayment } from "./lib/wait.ts"

// DF2: a one-off PH bank payment from quote to paid. The quote is the contract: the paid route
// must equal it, fees and FX must be exposed, and a leg may start only after the previous one
// succeeded.

const runId = Date.now().toString(36)

await execute(
	{ id: "DF2", title: "One-off payment, quote to paid", needs: ROUTES.df2 },
	async ({ api, env, fixtures, flow }) => {
		const spec = flowOf(fixtures, "df2")
		const expected = fixtures.expectations.df2
		const worker = workerOf(fixtures, spec.workerRef)
		const endpoint = endpointOf(worker, spec.endpointRef)
		const handles = await setUpWorker(api, flow, worker, endpoint)

		flow.route("POST", "/v1/quotes", "PH bank, send amount fixed")
		const quote = await api.quote({
			destination: {
				type: endpoint.type,
				country: endpoint.country,
				currency: endpoint.currency,
				recipientKind: worker.kind,
			},
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
		expectRouteRail(quote.route, "payout", expected.payoutRail!, "quote.route")
		expectRouteRail(quote.route, "settle", expected.settleRail!, "quote.route")
		if (!quote.fxRate) fail("quote has no fxRate")
		if (quote.fees === undefined) fail("quote has no fee breakdown")
		if (quote.expectedReceive.amount === "0")
			fail("quote expectedReceive is zero")
		expectFutureWindow(quote.validUntil, 180, "quote.validUntil")
		expectSimulated(quote.simulated, "quote")
		if (quote.reasons.length === 0) fail("quote has no reasons")
		flow.check("quote exposes route, fee, FX, receive amount and validity")

		flow.route("POST", "/v1/payments", "direct delivery from the quote")
		const created = await api.createPayment({
			quoteId: quote.id,
			recipientId: handles.recipient.id,
			endpointId: handles.endpoint.id,
			externalId: `df2-${runId}`,
			delivery: "direct",
			profile: "one_off",
		})
		if (created.payment.status !== "awaiting_funding") {
			fail(
				`new payment is ${created.payment.status}, expected awaiting_funding`,
			)
		}
		if (created.payment.legs.some((leg) => leg.status !== "pending")) {
			fail("a leg started before the payment was funded")
		}
		flow.check("payment awaits funding with every leg pending")

		flow.route("POST", `/v1/payments/${created.payment.id}/fund`)
		await api.fund(created.payment.id)
		const payment = await waitForPayment(api, created.payment.id)
		expectFrozenAccounting(quote, payment, "DF2")
		expectPaid(payment)
		if (payment.legs.at(-1)?.kind !== "payout")
			fail("a paid direct payment must end at payout")
		flow.legs("payment", payment.legs)
		flow.check("payment is paid only after the last leg succeeded")

		expectKinds(
			payment.legs.map((leg) => leg.kind),
			expected.legs,
			"payment.legs",
		)
		expectRail(payment.legs, "payout", expected.payoutRail!, "payment.legs")
		expectRail(payment.legs, "settle", expected.settleRail!, "payment.legs")
		if (payment.legs.some((leg) => leg.status !== "succeeded")) {
			fail("paid payment has a leg that did not succeed")
		}
		flow.check("paid route matches the quoted route")

		const events = payment.events ?? (await api.events(payment.id))
		expectEventTypes(
			events.map((event) => event.type),
			[
				"payment.created",
				"payment.funded",
				"payment.processing",
				"payment.onchain",
				"payment.paid",
			],
			"payment events",
		)
		flow.check("timeline carries created, funded, processing, onchain and paid")

		// H3: independently decode this payment's lock/release and tie them to the frozen
		// quote, configured vault, vault token, amounts and on-chain net transfer.
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
			const proof = await verifyVaultPayment({
				payment,
				quote,
				recipientAddress: env.recipientAddress,
				vaultContractId: env.payoutVaultId,
				expectedAssetContractId: env.assetContractId,
				rpcUrl: env.stellarRpcUrl,
				networkPassphrase: env.stellarNetworkPassphrase,
				timeoutMs: env.timeoutMs,
			})
			console.log(
				`chain  lock ${proof.lockHash} release ${proof.hash} payout ${proof.payoutId}`,
			)
			console.log(
				`vault  ${proof.contractId} asset ${proof.assetContractId} recipient ${maskAddress(proof.recipient)}`,
			)
			console.log(
				`amount principal ${proof.principal} fee ${proof.fee} net ${proof.net} feeMode ${proof.feeMode} bps ${proof.vaultFeeBps}`,
			)
			flow.check(
				"lock/release decode to the frozen payment, vault, asset, amount and payout",
			)
		}
	},
)
