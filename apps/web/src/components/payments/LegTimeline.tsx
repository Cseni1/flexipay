import { type Leg } from "@flexipay/web-lib/contract"
import { displayMoney } from "../../payments/quoteDisplay"
import { Notice, SimulatedLabel, StatusBadge, Timeline } from "../ui"

const KIND_LABELS: Record<Leg["kind"], string> = {
	collect: "Collect",
	convert: "Convert",
	settle: "Settle",
	payout: "Payout",
}

/**
 * Payment-detail journey. Simulated collect / convert / fiat payout legs always
 * carry SimulatedLabel; a live Solana settle leg (simulated=false) must not.
 */
export function LegTimeline({ legs }: { legs: Leg[] }) {
	if (legs.length === 0) {
		return (
			<div className="empty-state">
				<p className="empty-state__title">No legs yet</p>
				<p className="empty-state__body">
					The route's legs appear here as soon as the payment reaches them.
				</p>
			</div>
		)
	}

	return (
		<Timeline>
			{legs.map((leg) => (
				<li
					key={leg.id}
					className="timeline__item"
					data-testid={`payment-leg-${leg.kind}`}
					data-leg-kind={leg.kind}
					data-leg-simulated={leg.simulated ? "true" : "false"}
				>
					<span className="timeline__marker" aria-hidden="true" />
					<div className="timeline__body">
						<div className="timeline__heading">
							<strong className="timeline__title">
								{KIND_LABELS[leg.kind]}
							</strong>
							<StatusBadge status={leg.status} />
							{leg.simulated ? <SimulatedLabel /> : null}
						</div>
						<p className="timeline__meta">
							<code className="code-text">{leg.rail}</code>
							{leg.rail !== leg.providerId ? (
								<>
									<span aria-hidden="true"> · </span>
									{leg.providerId}
								</>
							) : null}
						</p>
						<p className="timeline__amounts">
							<span>
								{displayMoney(leg.amountIn.amount, leg.amountIn.currency)}
							</span>
							<span className="timeline__arrow" aria-hidden="true">
								→
							</span>
							<span>
								{displayMoney(leg.amountOut.amount, leg.amountOut.currency)}
							</span>
						</p>
						{leg.attempt > 1 ? (
							<p className="timeline__note">Attempt {leg.attempt}</p>
						) : null}
						{leg.reversalOf ? (
							<p className="timeline__note">
								Reversal of <code className="code-text">{leg.reversalOf}</code>
							</p>
						) : null}
						{leg.externalRef ? (
							<p className="timeline__reference">
								{leg.kind === "settle" ? "Payout id" : "Reference"}{" "}
								<code className="code-text">{leg.externalRef}</code>
							</p>
						) : null}
						{leg.lockTxRef ? (
							<p className="timeline__reference">
								Lock tx <code className="code-text">{leg.lockTxRef}</code>
							</p>
						) : null}
						{leg.releaseTxRef ? (
							<p className="timeline__reference">
								Release tx <code className="code-text">{leg.releaseTxRef}</code>
							</p>
						) : null}
						{leg.error ? (
							<Notice tone="warning">
								{leg.error.code}: {leg.error.message}
							</Notice>
						) : null}
					</div>
				</li>
			))}
		</Timeline>
	)
}
