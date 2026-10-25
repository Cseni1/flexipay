import {
	Button,
	InfoPopover,
	Notice,
	Panel,
	StatusBadge,
	type StatusValue,
} from "../ui"
import {
	canApprovePasskeyClaim,
	canCheckPasskeyRelease,
	canCreatePasskeyWallet,
	canPreparePasskeyClaim,
	canRetryPasskeyStep,
	isPasskeyBusy,
	type PasskeyClaimFlowState,
} from "./passkey-claim-flow"

// Rendering for the passkey claim (M2). Deliberately separate from ClaimPage and presentational:
// it reads flow state and calls handlers, it never talks to the API itself. The claim page renders
// it for the real CCR-21 chain (create → deploy → prepare → sign → submit); the DEV-only state
// gallery renders every phase from fixtures.

export interface PasskeyClaimPanelProps {
	flow: PasskeyClaimFlowState
	/** The claim is open in the API view but its `expiresAt` has passed. */
	claimExpired: boolean
	/** The claim is no longer open at all (accepted, cancelled or payment not processing). */
	claimClosed?: boolean
	onCreate?: () => void
	onPrepare?: () => void
	onApprove?: () => void
	onCheckRelease?: () => void
	onRetry?: () => void
	onCancel?: () => void
	onUseCryptoWallet?: () => void
}

const truncated = (value: string): string =>
	value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value

const PhaseCopy = ({ children }: { children: string }) => (
	<p className="form-note">{children}</p>
)

export function PasskeyClaimPanel({
	flow,
	claimExpired,
	claimClosed = false,
	onCreate,
	onPrepare,
	onApprove,
	onCheckRelease,
	onRetry,
	onCancel,
	onUseCryptoWallet,
}: PasskeyClaimPanelProps) {
	const expired = claimExpired || flow.phase === "expired"
	const busy = isPasskeyBusy(flow.phase)
	const fallback = onUseCryptoWallet ? (
		<Button
			variant="secondary"
			onClick={onUseCryptoWallet}
			data-testid="passkey-use-crypto"
		>
			Use a crypto wallet address instead
		</Button>
	) : null

	// Cancelling is safe before a deploy is sent: the ceremony result is ignored and no request
	// leaves the page. Once deploying, the page must not hide an in-flight wallet deploy.
	const cancellable =
		flow.phase === "creating_wallet" || (!busy && flow.phase !== "deployed")
	const cancel =
		onCancel && cancellable ? (
			<Button variant="ghost" onClick={onCancel} data-testid="passkey-cancel">
				Cancel
			</Button>
		) : null

	const retry = canRetryPasskeyStep(flow, expired) ? (
		<Button variant="secondary" onClick={onRetry} data-testid="passkey-retry">
			Retry
		</Button>
	) : null

	const phaseBody = () => {
		switch (flow.phase) {
			case "unavailable":
				return (
					<>
						<Notice tone="warning" data-testid="passkey-unavailable">
							Passkey wallet is not available in this build: the public testnet
							RPC URL or network passphrase is not configured. Your claim is
							unaffected.
						</Notice>
						{fallback}
					</>
				)

			case "unsupported":
				return (
					<>
						<Notice tone="warning">
							This browser cannot create a passkey wallet (WebAuthn is not
							available). A crypto wallet address still works.
						</Notice>
						{fallback}
					</>
				)

			case "idle":
				return (
					<>
						<PhaseCopy>
							Create a wallet unlocked by your fingerprint or face. Testnet
							only; no seed phrase is created.
						</PhaseCopy>
						{expired || claimClosed ? (
							<Notice tone="warning">
								This claim cannot start a passkey wallet now.
							</Notice>
						) : null}
						<div className="claim-demo">
							<Button
								onClick={onCreate}
								disabled={
									expired || claimClosed || !canCreatePasskeyWallet(flow)
								}
								data-testid="passkey-create"
							>
								Create passkey wallet
							</Button>
							{fallback}
						</div>
					</>
				)

			case "creating_wallet":
				return (
					<>
						<Notice tone="info">
							Waiting for your device: approve with your fingerprint or face.
							Your device may ask twice — once to create the passkey, once to
							authorise the wallet.
						</Notice>
						{cancel}
					</>
				)

			case "deploying":
				return (
					<>
						<Notice tone="info">
							Deploying the passkey wallet on testnet…
						</Notice>
						<p className="claim-meta">
							Contract account{" "}
							{flow.contractId ? truncated(flow.contractId) : "pending"}
						</p>
					</>
				)

			case "deployed":
				return (
					<>
						<Notice tone="info" data-testid="passkey-deployed">
							Wallet deployed on testnet.
						</Notice>
						<p className="claim-meta">
							Contract account{" "}
							{flow.contractId ? truncated(flow.contractId) : ""}
						</p>
						{flow.deployTxHash ? (
							<p className="claim-meta" data-testid="passkey-deploy-hash">
								Deploy transaction {truncated(flow.deployTxHash)}
							</p>
						) : null}
						<PhaseCopy>
							Next, the claim API prepares the release authorization and your
							passkey signs it. Nothing is paid until the API confirms the
							release.
						</PhaseCopy>
						<div className="claim-demo">
							<Button
								onClick={onPrepare}
								disabled={
									expired || claimClosed || !canPreparePasskeyClaim(flow)
								}
								data-testid="passkey-prepare"
							>
								Prepare claim release
							</Button>
							{fallback}
						</div>
					</>
				)

			case "deploy_failed":
				return (
					<>
						<Notice tone="warning" data-testid="passkey-deploy-error">
							{flow.message ?? "The wallet could not be deployed on testnet."}
						</Notice>
						<p className="form-note">
							{flow.retry === "create"
								? "Retrying asks your device for a passkey again; the earlier attempt created no wallet."
								: flow.retry === "deploy"
									? "Retrying sends the same deploy request with the same idempotency key, so no second wallet is created."
									: "This attempt cannot be repeated with the same request. Use a crypto wallet address instead."}
						</p>
						<div className="claim-demo">
							{retry}
							{cancel}
							{fallback}
						</div>
					</>
				)

			case "preparing":
				return (
					<>
						<Notice tone="info">Preparing the claim signature…</Notice>
						{cancel}
					</>
				)

			case "awaiting_signature":
				return (
					<>
						<PhaseCopy>
							Approve the claim with your passkey. The signature is prepared by
							the claim API; this page signs it once.
						</PhaseCopy>
						{flow.signatureExpirationLedger ? (
							<p className="claim-meta" data-testid="passkey-ledger">
								Signature valid until ledger {flow.signatureExpirationLedger}
							</p>
						) : null}
						{flow.message ? (
							<p className="form-note" data-testid="passkey-sign-note">
								{flow.message}
							</p>
						) : null}
						{expired ? (
							<Notice tone="warning" data-testid="passkey-expired">
								This claim link has expired. No release was made by this page.
							</Notice>
						) : null}
						<div className="claim-demo">
							<Button
								onClick={onApprove}
								disabled={claimClosed || !canApprovePasskeyClaim(flow, expired)}
								data-testid="passkey-approve"
							>
								Approve and claim
							</Button>
							{cancel}
						</div>
					</>
				)

			case "submitting":
				return (
					<>
						<Notice tone="info">Submitting the signed claim…</Notice>
						<Button disabled data-testid="passkey-submitting">
							Submitting…
						</Button>
					</>
				)

			case "processing":
				return (
					<>
						<Notice tone="info" data-testid="passkey-processing">
							The claim API is processing the release. This page does not mark
							it paid on its own.
						</Notice>
						{flow.pendingTxHash ? (
							<p className="claim-meta" data-testid="passkey-pending-hash">
								Pending transaction {truncated(flow.pendingTxHash)}
							</p>
						) : null}
						<div className="claim-demo">
							<Button
								variant="secondary"
								onClick={onCheckRelease}
								disabled={!canCheckPasskeyRelease(flow)}
								data-testid="passkey-check-release"
							>
								Check release status
							</Button>
						</div>
						<p className="form-note">
							Checking resends the same signed request with the same idempotency
							key, so it cannot release the claim twice.
						</p>
					</>
				)

			case "verified":
				return (
					<>
						<Notice tone="info" data-testid="passkey-verified">
							Confirmed by the claim API: the claim was accepted and the release
							reported.
						</Notice>
						<div className="claim-status-row">
							<StatusBadge
								status={
									(flow.verified?.paymentStatus ?? "processing") as StatusValue
								}
							/>
						</div>
					</>
				)

			case "unconfirmed":
				return (
					<Notice tone="warning" data-testid="passkey-unconfirmed">
						{flow.message ??
							"The claim API did not confirm this claim. Nothing here is marked paid."}
					</Notice>
				)

			case "retryable_error":
				return (
					<>
						<Notice tone="warning" data-testid="passkey-error">
							{flow.message ?? "The passkey claim failed. You can retry."}
						</Notice>
						{flow.retry === "submit" ? (
							<p className="form-note">
								Retrying reuses the same submit idempotency key, so the API sees
								one submission.
							</p>
						) : null}
						<div className="claim-demo">
							{retry}
							{cancel}
						</div>
					</>
				)

			case "cancelled":
				return (
					<>
						<Notice tone="info" data-testid="passkey-cancelled">
							Cancelled. No passkey claim was submitted.
						</Notice>
						{fallback}
					</>
				)

			case "expired":
				return (
					<>
						<Notice tone="warning" data-testid="passkey-expired">
							This claim link has expired. No release was made by this page.
						</Notice>
						{fallback}
					</>
				)
		}
	}

	return (
		<section data-testid="passkey-panel" data-passkey-phase={flow.phase}>
			<Panel
				title="Passkey wallet"
				description="No seed phrase: your fingerprint or face unlocks a Stellar contract account."
				actions={
					<InfoPopover label="Passkey wallet">
						The wallet is a contract account on Stellar testnet, so the claim is
						released to it without a trustline. The passkey kit in use is not
						audited; this build makes no real-money promise.
					</InfoPopover>
				}
			>
				<div className="stack">{phaseBody()}</div>
			</Panel>
		</section>
	)
}
