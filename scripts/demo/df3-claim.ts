import {
	expectEventTypes,
	expectFrozenAccounting,
	expectKinds,
	expectNoPayout,
	expectPaid,
	expectPayerPaysSizing,
	expectPayoutId,
	expectQuoteFeeMode,
	expectRouteRail,
	expectSimulated,
	expectTxRef,
	expectWaitingForClaim,
	fail,
} from "./lib/assertions.ts"
import { endpointOf, flowOf, workerOf } from "./lib/fixtures.ts"
import { maskAddress, readVaultEvidence } from "./lib/env.ts"
import { BlockedError } from "./lib/report.ts"
import { ROUTES } from "./lib/routes.ts"
import { execute, modeArg } from "./lib/script.ts"
import { setUpWorker } from "./lib/setup.ts"
import { verifyVaultRelease } from "./lib/stellar-proof.ts"
import { waitForPayment } from "./lib/wait.ts"

// DF3: public claim link to a crypto wallet. Funding may collect, convert and lock, but the funds
// must stay locked until the recipient accepts; acceptance releases them and only then is the
// payment paid. `--mode` selects which adapter the run asks for; it is not evidence of what
// settled. On Stellar the lock must be this payment's create_payout and the release must be its
// claim to the intended recipient, checked from both envelopes on the configured testnet RPC.

const runId = Date.now().toString(36)
const requestedMode = modeArg(
	process.argv,
	process.env.FP_SETTLEMENT?.toLowerCase() === "stellar" ? "stellar" : "mock",
)

await execute(
	{
		id: "DF3",
		title: "Claim link to a crypto wallet",
		needs: ROUTES.df3,
		mode: requestedMode,
	},
	async ({ api, env, fixtures, flow }) => {
		const spec = flowOf(fixtures, "df3")
		const expected = fixtures.expectations.df3
		const worker = workerOf(fixtures, spec.workerRef)
		const endpoint = endpointOf(worker, spec.endpointRef)

		// CCR-13's fee rate comes from the existing public testnet evidence, tied to the deployed
		// vault id. DF3 never accepts a separate fee setting that could excuse wrong accounting.
		const feeEvidence = readVaultEvidence()
		if (requestedMode === "stellar") {
			if (!feeEvidence.ok) {
				throw new BlockedError([
					{
						what: `the deployed vault fee is unavailable: ${feeEvidence.problem}`,
						owner: "caller / Csaba (integration)",
						detail:
							"scripts/testnet/testnet-ids.env is the public deployment evidence used by the API; no separate fee setting is accepted",
					},
				])
			}
			if (feeEvidence.evidence.vaultId !== env.payoutVaultId) {
				throw new BlockedError([
					{
						what: `the fee evidence is for vault ${feeEvidence.evidence.vaultId}, not the configured ${env.payoutVaultId ?? "(none)"}`,
						owner: "caller / Csaba (integration)",
						detail:
							"point DF3 at the vault described by scripts/testnet/testnet-ids.env, or regenerate that evidence from the deployment",
					},
				])
			}
		}
		const vaultFeeBps = feeEvidence.ok ? feeEvidence.evidence.feeBps : undefined
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
			feeMode: spec.feeMode,
			policy: "cheapest",
		})
		expectQuoteFeeMode(quote, spec.feeMode)
		if (vaultFeeBps !== undefined) {
			expectPayerPaysSizing(quote, vaultFeeBps, "DF3")
		}
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
		const fundedSettle = waiting.legs.find((leg) => leg.kind === "settle")
		if (!fundedSettle) fail("funded claim payment has no settle leg")
		const payoutId = expectPayoutId(
			fundedSettle.externalRef,
			"funded settle.externalRef",
		)
		const lockTxRef = fundedSettle.lockTxRef
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
			`${expected.claimType}, requested ${requestedMode}`,
		)
		const accepted = await api.acceptClaim(token, {
			endpointId: handles.endpoint.id,
			type: expected.claimType,
			...(requestedMode === "stellar" && env.recipientAddress
				? { address: env.recipientAddress }
				: {}),
		})
		const payment =
			accepted.status === "paid"
				? accepted
				: await api.payment(created.payment.id)
		expectPaid(payment)
		expectNoPayout(payment.legs, "payment.legs")
		expectFrozenAccounting(quote, payment, "DF3")
		flow.legs("accepted", payment.legs)
		flow.check("acceptance released the funds and the payment is paid")

		// CCR-12: settle.externalRef is the payoutId; lockTxRef/releaseTxRef carry the hashes.
		const settle = payment.legs.find((leg) => leg.kind === "settle")
		if (!settle) fail("accepted payment has no settle leg")
		const releasedPayoutId = expectPayoutId(
			settle.externalRef,
			"accepted settle.externalRef",
		)
		if (releasedPayoutId !== payoutId) {
			fail(
				`payoutId changed from ${payoutId} to ${releasedPayoutId} across acceptance`,
			)
		}
		const releaseTxRef = settle.releaseTxRef

		if (requestedMode === "stellar") {
			if (
				!env.stellarRpcUrl ||
				!env.stellarNetworkPassphrase ||
				!env.payoutVaultId ||
				!env.recipientAddress
			) {
				throw new BlockedError([
					{
						what: "Stellar RPC, passphrase, vault id and recipient address are required to verify a vault release",
						owner: "caller / Csaba (integration)",
					},
				])
			}
			if (!lockTxRef) {
				throw new BlockedError([
					{
						what: "the funding settle leg has no lockTxRef",
						owner: "CC2 (orchestrator)",
						detail:
							"CCR-12 requires lockTxRef on the settle leg; externalRef alone is the payoutId, not a transaction hash",
					},
				])
			}
			if (!releaseTxRef) {
				throw new BlockedError([
					{
						what: "the accepted settle leg has no releaseTxRef",
						owner: "CC2 (orchestrator)",
						detail:
							"CCR-12 requires releaseTxRef; externalRef is the payoutId only",
					},
				])
			}
			if (!quote.fees || !quote.feeMode) {
				fail("settle quote is missing fees or feeMode for the lock proof")
			}
			const quotedSettle = quote.route.find((leg) => leg.kind === "settle")
			if (!quotedSettle?.amountIn || !quotedSettle.amountOut) {
				fail("settle quote is missing frozen principal or net")
			}
			if (vaultFeeBps === undefined) {
				throw new BlockedError([
					{
						what: "the deployed vault fee is unavailable, so the quote fee cannot be checked against the lock",
						owner: "caller / Csaba (integration)",
						detail:
							"scripts/testnet/testnet-ids.env must describe the configured vault (CCR-13)",
					},
				])
			}
			expectTxRef(lockTxRef, "stellar", "lock")
			expectTxRef(releaseTxRef, "stellar", "release")
			const proof = await verifyVaultRelease({
				paymentId: payment.id,
				payoutId,
				lockHash: lockTxRef,
				releaseHash: releaseTxRef,
				recipientAddress: env.recipientAddress,
				vaultContractId: env.payoutVaultId,
				principal: quotedSettle.amountIn.amount,
				feeMode: quote.feeMode,
				fee: quote.fees.flexiPayFee.amount,
				net: quotedSettle.amountOut.amount,
				vaultFeeBps,
				rpcUrl: env.stellarRpcUrl,
				networkPassphrase: env.stellarNetworkPassphrase,
				timeoutMs: env.timeoutMs,
			})
			console.log(`hash   lock    ${proof.lockHash}`)
			console.log(`hash   release ${proof.hash}`)
			console.log(
				`chain  testnet ledger ${proof.ledger} status ${proof.status} payout ${proof.payoutId}`,
			)
			console.log(
				`vault  ${proof.contractId}  recipient ${maskAddress(proof.recipient)}`,
			)
			console.log(
				`ccr13 principal ${proof.principal} fee ${proof.fee} net ${proof.net} mode ${proof.feeMode}`,
			)
			flow.check(
				"lock is create_payout for this payment; release claims the same payout id",
			)
			flow.check("release pays the intended Worker A recipient address")
			flow.check("lock principal, feeMode, fee and net match the frozen quote")
		} else {
			if (!lockTxRef || !releaseTxRef) {
				throw new BlockedError([
					{
						what: "mock claim payment is missing lockTxRef or releaseTxRef",
						owner: "CC2 (orchestrator)",
						detail:
							"CCR-12 separates the payoutId from the mock transaction references",
					},
				])
			}
			expectTxRef(lockTxRef, "mock", "lock")
			expectTxRef(releaseTxRef, "mock", "release")
			flow.check("payoutId is distinct from the mock lock/release references")
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
