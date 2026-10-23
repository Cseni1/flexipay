import {
	expectEventTypes,
	expectKinds,
	expectNoPayout,
	expectPaid,
	expectRouteRail,
	expectSimulated,
	expectTxRef,
	expectWaitingForClaim,
	fail,
} from "./lib/assertions.ts"
import { endpointOf, flowOf, workerOf } from "./lib/fixtures.ts"
import { ROUTES } from "./lib/routes.ts"
import { execute, modeArg } from "./lib/script.ts"
import { setUpWorker } from "./lib/setup.ts"
import { waitForPayment } from "./lib/wait.ts"

// DF3: public claim link to a crypto wallet. Funding may collect, convert and lock, but the funds
// must stay locked until the recipient accepts; acceptance releases them and only then is the
// payment paid. In Stellar mode the release must be a real 64-hex testnet transaction hash.

const runId = Date.now().toString(36)
const mode = modeArg(
	process.argv,
	process.env.FP_SETTLEMENT?.toLowerCase() === "stellar" ? "stellar" : "mock",
)

await execute(
	{
		id: "DF3",
		title: "Claim link to a crypto wallet",
		needs: ROUTES.df3,
		mode,
	},
	async ({ api, env, fixtures, flow }) => {
		const spec = flowOf(fixtures, "df3")
		const expected = fixtures.expectations.df3
		const worker = workerOf(fixtures, spec.workerRef)
		const endpoint = endpointOf(worker, spec.endpointRef)
		const handles = await setUpWorker(api, flow, worker, endpoint)

		flow.route("POST", "/v1/quotes", "PH crypto wallet, send amount fixed")
		const quote = await api.quote({
			destination: {
				type: expected.claimType,
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
		if (quote.route.some((leg) => leg.kind === "payout")) {
			fail("crypto quote must not plan a payout leg")
		}
		expectRouteRail(quote.route, "settle", expected.settleRail!, "quote.route")
		expectSimulated(quote.simulated, "quote")
		flow.check("crypto quote ends at settle with no payout leg")

		flow.route("POST", "/v1/payments", "delivery claim_link")
		const created = await api.createPayment({
			quoteId: quote.id,
			recipientId: handles.recipient.id,
			externalId: `df3-${runId}`,
			delivery: "claim_link",
			profile: "one_off",
		})
		const token = created.claimToken
		if (!token) fail("claim-link payment returned no claim token")

		flow.route("POST", `/v1/payments/${created.payment.id}/fund`)
		const funded = await api.fund(created.payment.id)
		const waiting = await waitForPayment(
			api,
			created.payment.id,
			(payment) => payment.status === "paid" || payment.status === "failed",
		)
		expectWaitingForClaim(funded)
		expectWaitingForClaim(waiting)
		flow.legs("funded", waiting.legs)
		const lockRef = waiting.legs.find(
			(leg) => leg.kind === "settle",
		)?.externalRef
		flow.check("funds are locked and the payment is not paid before acceptance")

		flow.route("GET", "/v1/claims/{token}", "public claim view")
		const claim = await api.claim(token)
		if (
			claim.allowedEndpointTypes &&
			!claim.allowedEndpointTypes.includes(expected.claimType)
		) {
			fail(`claim does not offer ${expected.claimType}`)
		}
		if (claim.amount && quote.expectedReceive.amount !== claim.amount.amount) {
			fail(
				`claim shows ${claim.amount.amount} ${claim.amount.currency}, quoted ${quote.expectedReceive.amount} ${quote.expectedReceive.currency}`,
			)
		}
		flow.check("claim view shows what is waiting")

		const stillWaiting = await api.payment(created.payment.id)
		expectWaitingForClaim(stillWaiting)
		flow.check("opening the claim did not release the funds")

		flow.route(
			"POST",
			"/v1/claims/{token}/accept",
			`${expected.claimType}, ${mode}`,
		)
		const accepted = await api.acceptClaim(token, {
			endpointId: handles.endpoint.id,
			type: expected.claimType,
			...(mode === "stellar" && env.cryptoAddress
				? { address: env.cryptoAddress }
				: {}),
		})
		const payment =
			accepted.payment.status === "paid"
				? accepted.payment
				: await api.payment(created.payment.id)
		expectPaid(payment)
		expectNoPayout(payment.legs, "payment.legs")
		flow.legs("accepted", payment.legs)
		flow.check("acceptance released the funds and the payment is paid")

		const settle = payment.legs.find((leg) => leg.kind === "settle")
		const releaseRef = accepted.release?.txRef ?? settle?.externalRef
		const network = accepted.release?.network ?? mode
		expectTxRef(releaseRef, mode, "release")
		if (network !== mode)
			fail(`release network is ${network}, expected ${mode}`)
		flow.check(`release reference is a ${mode} reference`)

		if (mode === "stellar") {
			if (!lockRef) fail("no lock reference was recorded at funding")
			if (lockRef === releaseRef)
				fail("lock and release share one transaction hash")
			console.log(`hash   release ${releaseRef}`)
			console.log(`hash   lock    ${lockRef}`)
			flow.check("lock and release are distinct testnet transactions")
		}

		const events = payment.events ?? (await api.events(payment.id))
		expectEventTypes(
			events.map((event) => event.type),
			["claim.accepted", "payment.onchain", "payment.paid"],
			"payment events",
		)
		flow.check("claim acceptance, release and paid are on the timeline")
	},
)
