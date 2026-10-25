import { useReducer } from "react"
import {
	initialPasskeyFlow,
	isPasskeySupported,
	passkeyClaimReducer,
	type PasskeyClaimFlowState,
} from "../components/claim/passkey-claim-flow"
import { PasskeyClaimPanel } from "../components/claim/PasskeyClaimPanel"

// DEV-only state gallery for the passkey claim (M2). This page is a test surface for the UI
// states, not a passkey run and not a claim: it is registered only when `import.meta.env.DEV`,
// so a production build has no route to it. It never sends a request and holds no XDR payload.
//
// CCR-20 deploy is accepted and the real flow lives on the claim page; prepare/submit are still
// stubs, so their states are fixture-only here.

const scenario = (
	name: string,
	flow: PasskeyClaimFlowState,
): { name: string; flow: PasskeyClaimFlowState } => ({ name, flow })

const accepted = () =>
	initialPasskeyFlow({ deployAvailable: true, supported: true })

const FIXTURE_CONTRACT_ID =
	"CFIXTUREWALLETCONTRACTACCOUNT00000000000000000000000000000"
const FIXTURE_DEPLOY_HASH = "ab".repeat(32)

const scenarios = [
	scenario(
		"unavailable",
		initialPasskeyFlow({ deployAvailable: false, supported: true }),
	),
	scenario(
		"unsupported",
		initialPasskeyFlow({ deployAvailable: true, supported: false }),
	),
	scenario("idle", accepted()),
	scenario("creating_wallet", {
		...accepted(),
		phase: "creating_wallet",
	}),
	scenario("deploying", {
		...accepted(),
		phase: "deploying",
		contractId: "CFIXTUREWALLETCONTRACTACCOUNT00000000000000000000000000000",
		deployIdempotencyKey: "fixture-deploy-key",
	}),
	scenario("deployed", {
		...accepted(),
		phase: "deployed",
		contractId: FIXTURE_CONTRACT_ID,
		deployTxHash: FIXTURE_DEPLOY_HASH,
		deployIdempotencyKey: "fixture-deploy-key",
	}),
	scenario("deploy_failed", {
		...accepted(),
		phase: "deploy_failed",
		contractId: "CFIXTUREWALLETCONTRACTACCOUNT00000000000000000000000000000",
		deployIdempotencyKey: "fixture-deploy-key",
		retry: "deploy",
		message: "The deploy request was not accepted by the claim API.",
	}),
	scenario("preparing", {
		...accepted(),
		phase: "preparing",
		contractId: "CFIXTUREWALLETCONTRACTACCOUNT00000000000000000000000000000",
	}),
	scenario("awaiting_signature", {
		...accepted(),
		phase: "awaiting_signature",
		contractId: "CFIXTUREWALLETCONTRACTACCOUNT00000000000000000000000000000",
		prepareId: "fixture-prepare",
	}),
	scenario("submitting", {
		...accepted(),
		phase: "submitting",
		contractId: "CFIXTUREWALLETCONTRACTACCOUNT00000000000000000000000000000",
		prepareId: "fixture-prepare",
		submitIdempotencyKey: "fixture-submit-key",
	}),
	scenario("processing", {
		...accepted(),
		phase: "processing",
		contractId: "CFIXTUREWALLETCONTRACTACCOUNT00000000000000000000000000000",
		prepareId: "fixture-prepare",
		submitIdempotencyKey: "fixture-submit-key",
	}),
	scenario("verified", {
		...accepted(),
		phase: "verified",
		contractId: "CFIXTUREWALLETCONTRACTACCOUNT00000000000000000000000000000",
		verified: { claimStatus: "accepted", paymentStatus: "paid" },
	}),
	scenario("unconfirmed", {
		...accepted(),
		phase: "unconfirmed",
		contractId: "CFIXTUREWALLETCONTRACTACCOUNT00000000000000000000000000000",
		message:
			"The claim API did not confirm the claim as accepted. Nothing here is marked paid.",
	}),
	scenario("retryable_error", {
		...accepted(),
		phase: "retryable_error",
		contractId: "CFIXTUREWALLETCONTRACTACCOUNT00000000000000000000000000000",
		prepareId: "fixture-prepare",
		submitIdempotencyKey: "fixture-submit-key",
		retry: "submit",
		message: "The claim API could not be reached. Nothing was submitted twice.",
	}),
	scenario("cancelled", { ...accepted(), phase: "cancelled" }),
	scenario("expired", { ...accepted(), phase: "expired" }),
	// Claim no longer acceptable (for example the payment is not processing).
	scenario("awaiting_signature_closed", {
		...accepted(),
		phase: "awaiting_signature",
		contractId: "CFIXTUREWALLETCONTRACTACCOUNT00000000000000000000000000000",
		prepareId: "fixture-prepare",
	}),
	// Expiry reached while a signature is pending: approval must be disabled.
	scenario("awaiting_signature_expired", {
		...accepted(),
		phase: "awaiting_signature",
		contractId: "CFIXTUREWALLETCONTRACTACCOUNT00000000000000000000000000000",
		prepareId: "fixture-prepare",
	}),
]

const LiveSupportScenario = () => {
	const [flow] = useReducer(
		passkeyClaimReducer,
		initialPasskeyFlow({
			deployAvailable: true,
			supported: isPasskeySupported(),
		}),
	)
	return (
		<div className="stack" data-scenario="live-support">
			<p className="muted">
				Live browser detection with the accepted CCR-20 deploy route; prepare
				and submit are still stubs.
			</p>
			<PasskeyClaimPanel flow={flow} claimExpired={false} />
		</div>
	)
}

const InteractiveScenario = ({
	name,
	initial,
	claimExpired = false,
	claimClosed = false,
}: {
	name: string
	initial: PasskeyClaimFlowState
	claimExpired?: boolean
	claimClosed?: boolean
}) => {
	const [flow, dispatch] = useReducer(passkeyClaimReducer, initial)
	return (
		<div className="stack" data-scenario={name}>
			<p className="muted">Scenario: {name}</p>
			<PasskeyClaimPanel
				flow={flow}
				claimExpired={claimExpired}
				claimClosed={claimClosed}
				onCreate={() => dispatch({ type: "wallet_creation_started" })}
				onApprove={() =>
					dispatch({
						type: "signature_approved",
						submitIdempotencyKey: `fixture-submit-${crypto.randomUUID()}`,
					})
				}
				onRetry={() => dispatch({ type: "retry" })}
				onCancel={() => dispatch({ type: "cancelled" })}
				onUseCryptoWallet={() => undefined}
			/>
		</div>
	)
}

export default function PasskeyClaimStates() {
	return (
		<main className="phone-shell">
			<div className="phone-frame">
				<header className="phone-header">
					<span className="phone-brand">FlexiPay</span>
					<span className="simulated-label" data-simulated="true">
						Fixture
					</span>
				</header>
				<div className="stack">
					<div>
						<p className="eyebrow">DEV-only component gallery</p>
						<h1 className="phone-title">Passkey claim states</h1>
						<p className="muted">
							UI states for the passkey claim. Fixture states only: this is not
							a passkey run and not a testnet claim.
						</p>
					</div>
					<LiveSupportScenario />
					{scenarios.map((item) => (
						<InteractiveScenario
							key={item.name}
							name={item.name}
							initial={item.flow}
							claimExpired={item.name === "awaiting_signature_expired"}
							claimClosed={item.name === "awaiting_signature_closed"}
						/>
					))}
				</div>
			</div>
		</main>
	)
}
