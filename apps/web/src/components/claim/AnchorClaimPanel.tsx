import { type ClaimView } from "@flexipay/web-lib/claim-contract"
import { Button, Notice, StatusBadge } from "../ui"
import {
	anchorOutcomeLabel,
	canStartWithdraw,
	type AnchorFlowState,
} from "./anchor-claim-flow"

// Presentation for the M1 reference-anchor cash-out. Two legs are shown separately on purpose:
// the claim/payment status (claim API) and the anchor withdrawal status (SEP-24 poll). A paid
// payment is not a bank payout, and an opened hosted screen would not be one either.

export interface AnchorClaimPanelProps {
	state: AnchorFlowState
	claim: ClaimView
	claimExpired: boolean
	onStart: () => void
	onRetry: () => void
	/** Omitted once the claim is already accepted: there is nothing to switch back to. */
	onUseCryptoWallet?: () => void
}

const anchorTone = (state: AnchorFlowState): string => {
	if (state.statusKind === "completed") return "success"
	if (state.statusKind === "failed") return "danger"
	if (state.anchorTxId) return "warning"
	return "neutral"
}

export function AnchorClaimPanel({
	state,
	claim,
	claimExpired,
	onStart,
	onRetry,
	onUseCryptoWallet,
}: AnchorClaimPanelProps) {
	const expired = claimExpired || state.phase === "expired"
	const released = claim.status === "accepted"
	const startable = canStartWithdraw(state) && released && !expired

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
						The anchor's hosted screen applies the final rate and fees; this
						page computes neither.
					</p>
				</div>
			) : null}

			{state.quoteProblem ? (
				<Notice tone="warning" data-testid="anchor-quote-error">
					{state.quoteProblem}
				</Notice>
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
					These are separate records. A paid payment, or an opened hosted
					screen, is not proof that a bank received money.
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
					This claim link has expired. No anchor withdrawal can be started or
					polled.
				</Notice>
			) : null}

			{state.withdrawProblem ? (
				<Notice tone="warning" data-testid="anchor-withdraw-error">
					{state.withdrawProblem}
				</Notice>
			) : null}

			{state.anchorTxId ? (
				<div className="stack" data-testid="anchor-withdraw-started">
					<p className="form-note">
						Anchor transaction id (public, safe to share):{" "}
						<code className="code-text" data-testid="anchor-tx-id">
							{state.anchorTxId}
						</code>
					</p>
					{state.hostedFlow ? (
						<Notice tone="warning" data-testid="anchor-hosted-blocked">
							The claim API returns only a sanitised hosted link, with the
							SEP-24 session token removed, so this page cannot open the
							anchor's hosted screen. No link is invented here. The anchor
							transaction is recorded and polled below; completing the hosted
							step needs a contracted browser-safe link from the API.
						</Notice>
					) : null}
					<p className="form-note">
						The classic memo payment to the anchor is a separate backend step
						and is not wired in this build.
					</p>
				</div>
			) : null}

			<div className="claim-demo">
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
