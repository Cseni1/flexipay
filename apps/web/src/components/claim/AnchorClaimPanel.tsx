import { type ClaimView } from "@flexipay/web-lib/claim-contract"
import { Button, Notice, StatusBadge } from "../ui"
import {
	anchorCompleted,
	anchorOutcomeLabel,
	canRepeatPay,
	canStartPay,
	canStartWithdraw,
	type AnchorFlowState,
} from "./anchor-claim-flow"

// Presentation for the M1 reference-anchor cash-out. Separate records are shown separately:
// vault release, our classic payment hash, the anchor's Stellar transaction and the SEP-24
// transaction. Only the anchor's completed terminal status is completed; submitted, paid,
// opened and terminal-by-itself are not.

export interface AnchorClaimPanelProps {
	state: AnchorFlowState
	claim: ClaimView
	claimExpired: boolean
	onStart: () => void
	onRetry: () => void
	onRetryQuote: () => void
	onPay: () => void
	onOpenHosted: () => void
	/** Omitted once the claim is already accepted: there is nothing to switch back to. */
	onUseCryptoWallet?: () => void
}

const anchorTone = (state: AnchorFlowState): string => {
	if (anchorCompleted(state)) return "success"
	if (state.statusKind === "failed" || state.status?.terminal) return "danger"
	if (state.anchorTxId) return "warning"
	return "neutral"
}

interface RefRowProps {
	label: string
	value: string | null | undefined
	testId: string
}

const RefRow = ({ label, value, testId }: RefRowProps) =>
	value ? (
		<p data-testid={testId}>
			{label}: <code className="code-text">{value}</code>
		</p>
	) : null

export function AnchorClaimPanel({
	state,
	claim,
	claimExpired,
	onStart,
	onRetry,
	onRetryQuote,
	onPay,
	onOpenHosted,
	onUseCryptoWallet,
}: AnchorClaimPanelProps) {
	const expired = claimExpired || state.phase === "expired"
	const released = claim.status === "accepted"
	const startable = canStartWithdraw(state) && released && !expired
	const payButton = canStartPay(state)
	const repeatPay = canRepeatPay(state)
	const terminal = state.status?.terminal === true

	return (
		<div className="stack" data-testid="anchor-panel">
			<div className="claim-demo">
				<span
					className="status-badge status-badge--warning"
					data-testid="anchor-indicative-badge"
				>
					<span className="status-badge__dot" aria-hidden="true" />
					Indicative
				</span>
				<p className="form-note">
					Reference anchor on testnet: the hosted anchor pays a US-dollar bank
					account in its sandbox. This is not a local bank payout, and the price
					below is not a binding quote.
				</p>
			</div>

			{state.phase === "quoting" ? (
				<p className="muted" role="status">
					Loading indicative price…
				</p>
			) : null}

			{state.quote ? (
				<div className="claim-meta" data-testid="anchor-quote">
					<p>
						Sell: <strong>{state.quote.sellAmount}</strong>{" "}
						<code className="code-text">{state.quote.sellAsset}</code>
					</p>
					<p>
						Indicative receive: <strong>{state.quote.buyAmount}</strong>{" "}
						<code className="code-text">{state.quote.buyAsset}</code>
					</p>
					<p>Anchor price: {state.quote.price} (SEP-38, context sep6)</p>
					<p>
						Quoted for {state.quoteAmount} USDC of this claim. The withdrawal
						amount is the claim's net amount from the API, not this gross
						figure.
					</p>
					<p>
						The anchor's hosted screen applies the final rate and fees; this
						page computes neither.
					</p>
				</div>
			) : null}

			{state.phase === "quote_skipped" ? (
				<Notice tone="info" data-testid="anchor-quote-skipped">
					No indicative price is requested: the claim amount is outside the
					anchor's 1–10 USDC quote window. The withdrawal still uses the claim's
					net amount, which the API resolves; this page does not substitute the
					gross claim amount.
				</Notice>
			) : null}

			{state.quoteProblem ? (
				<Notice tone="warning" data-testid="anchor-quote-error">
					{state.quoteProblem}
				</Notice>
			) : null}

			{state.quoteProblem && state.quoteRetryable ? (
				<Button
					variant="secondary"
					onClick={onRetryQuote}
					data-testid="anchor-retry-quote"
				>
					Retry the indicative price
				</Button>
			) : null}

			<div className="claim-meta" data-testid="anchor-legs">
				<p>
					Vault release / payment (claim API):{" "}
					<StatusBadge status={claim.paymentStatus} />
				</p>
				<p>
					Anchor withdrawal:{" "}
					<span
						className={`status-badge status-badge--${anchorTone(state)}`}
						data-anchor-status={state.status?.status ?? "not_started"}
						data-anchor-terminal={String(terminal)}
						data-testid="anchor-status"
					>
						<span className="status-badge__dot" aria-hidden="true" />
						{anchorOutcomeLabel(state)}
					</span>
				</p>
				{state.status ? (
					<p data-testid="anchor-status-raw">
						Anchor transaction status:{" "}
						<code className="code-text">{state.status.status}</code>
						{state.status.withdrawMemoPresent
							? " · the anchor expects a memo on the classic payment"
							: ""}
					</p>
				) : null}
				<p>
					These are separate records. A paid payment, a submitted classic
					payment or an opened hosted screen is not proof that a bank received
					money.
				</p>
			</div>

			{state.statusProblem ? (
				<Notice tone="warning" data-testid="anchor-status-error">
					{state.statusProblem}
				</Notice>
			) : null}

			{!released && !expired ? (
				<Notice tone="info" data-testid="anchor-release-required">
					The anchor rail starts after the vault release to a classic{" "}
					<code>G…</code> account. Accept this claim to a crypto wallet address
					first, then reopen this option.
				</Notice>
			) : null}

			{expired ? (
				<Notice tone="warning">
					This claim link has expired. No anchor withdrawal or payment can be
					started or polled.
				</Notice>
			) : null}

			{state.withdrawProblem ? (
				<Notice tone="warning" data-testid="anchor-withdraw-error">
					{state.withdrawProblem}
				</Notice>
			) : null}

			{state.anchorTxId ? (
				<div className="stack" data-testid="anchor-withdraw-started">
					<Notice tone="info">
						Withdrawal amount: the claim's net USDC amount, resolved by the API.
						This page did not send an amount.
					</Notice>

					{state.hosted === "opened" ? (
						<Notice tone="info" data-testid="anchor-hosted-opened">
							The anchor's hosted screen was opened in a new tab. Finish the
							anchor's form there; returning here never pays automatically.
						</Notice>
					) : null}
					{state.hosted === "ready" ? (
						<Notice tone="warning" data-testid="anchor-hosted-blocked">
							Your browser blocked the new tab. Use the button below to open the
							anchor's hosted screen from the link the API returned once.
						</Notice>
					) : null}
					{state.hosted === "replay_missing" ? (
						<Notice tone="warning" data-testid="anchor-hosted-replay">
							This is a replay response: the API returns the hosted screen link
							only on the first withdrawal response, so no link is available and
							none is invented. The SEP-24 transaction below is still polled.
						</Notice>
					) : null}
					{state.hosted === "invalid" ? (
						<Notice tone="warning" data-testid="anchor-hosted-invalid">
							The API's hosted URL was not a safe absolute http(s) link, so it
							was not opened. No alternative URL is invented.
						</Notice>
					) : null}
					{state.hosted === "opened" || state.hosted === "ready" ? (
						<Button
							variant="secondary"
							onClick={onOpenHosted}
							data-testid="anchor-open-hosted"
						>
							Open the hosted anchor screen
						</Button>
					) : null}

					<div className="claim-meta" data-testid="anchor-refs">
						<RefRow
							label="SEP-24 anchor transaction (anchorTxId)"
							value={state.status?.anchorTxId ?? state.anchorTxId}
							testId="anchor-ref-anchor-tx"
						/>
						<RefRow
							label="Vault release (vaultReleaseTxRef)"
							value={state.status?.vaultReleaseTxRef}
							testId="anchor-ref-releasetxref"
						/>
						<RefRow
							label="Our classic payment (anchorPaymentTxHash)"
							value={state.status?.anchorPaymentTxHash ?? state.submittedHash}
							testId="anchor-ref-payment-hash"
						/>
						<RefRow
							label="Anchor's Stellar transaction (anchorStellarTransactionId)"
							value={state.status?.anchorStellarTransactionId}
							testId="anchor-ref-stellar-tx"
						/>
					</div>

					{anchorCompleted(state) ? (
						<Notice tone="info" data-testid="anchor-completed">
							Anchor withdrawal completed in the reference anchor's testnet
							sandbox.
						</Notice>
					) : null}
					{terminal && !anchorCompleted(state) ? (
						<Notice tone="warning" data-testid="anchor-terminal-not-completed">
							The anchor transaction is terminal but not completed. This page
							does not treat it as a successful cash-out.
						</Notice>
					) : null}

					{state.payProblem ? (
						<Notice tone="warning" data-testid="anchor-pay-error">
							{state.payProblem}
						</Notice>
					) : null}

					{state.pay === "submitted" ? (
						<Notice tone="info" data-testid="anchor-pay-submitted">
							Classic payment submitted (HTTP 200). This is not a completed
							cash-out; only the anchor's own status decides that.
						</Notice>
					) : null}
					{state.pay === "pending" ? (
						<Notice tone="warning" data-testid="anchor-pay-pending">
							The payment outcome is uncertain (HTTP 202). Retrying only
							reconciles the retained transaction hash; no second payment is
							sent.
						</Notice>
					) : null}
					{state.pendingHash ? (
						<RefRow
							label="Retained payment (pendingTxHash)"
							value={state.pendingHash}
							testId="anchor-ref-pending-hash"
						/>
					) : null}

					{payButton ? (
						<Button onClick={onPay} data-testid="anchor-pay">
							Pay the anchor (classic memo payment)
						</Button>
					) : null}
					{repeatPay ? (
						<Button
							variant="secondary"
							onClick={onPay}
							disabled={state.pay === "submitting"}
							data-testid="anchor-pay-retry"
						>
							{state.pay === "pending"
								? "Reconcile the retained payment (same key)"
								: "Retry the same payment request"}
						</Button>
					) : null}
					{!payButton && !repeatPay && state.pay === "idle" ? (
						<p className="form-note" data-testid="anchor-pay-idle-note">
							The payment action appears only when the anchor's status is{" "}
							<code>pending_user_transfer_start</code>. It is never triggered by
							polling or by returning from the hosted screen.
						</p>
					) : null}
					<p className="form-note">
						One classic memo payment, started only by the button above. An
						uncertain outcome is reconciled by transaction hash; a definitive
						409 is not retried with a new idempotency key.
					</p>
				</div>
			) : null}

			<div className="claim-demo">
				{state.anchorTxId ? null : (
					<>
						<Button
							onClick={onStart}
							disabled={!startable || state.phase === "withdrawing"}
							data-testid="anchor-start"
						>
							{state.phase === "withdrawing"
								? "Starting anchor withdrawal…"
								: "Start anchor withdrawal"}
						</Button>
						{state.withdrawProblem && state.withdrawRetryable ? (
							<Button
								variant="secondary"
								onClick={onRetry}
								disabled={state.phase === "withdrawing"}
								data-testid="anchor-retry"
							>
								Retry the same request
							</Button>
						) : null}
					</>
				)}
				{onUseCryptoWallet ? (
					<Button variant="secondary" onClick={onUseCryptoWallet}>
						Use a crypto wallet address instead
					</Button>
				) : null}
			</div>
			<p className="form-note">
				One idempotent request starts the anchor withdrawal. A retry reuses the
				same body and idempotency key, so it cannot start a second withdrawal.
			</p>
		</div>
	)
}
