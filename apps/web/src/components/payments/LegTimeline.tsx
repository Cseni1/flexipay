import { type Event, type Leg } from "@flexipay/web-lib/contract"
import { legEventTime } from "../../payments/paymentEventTimes"
import { providerLabel } from "../../payments/providerNames"
import { displayMoney } from "../../payments/quoteDisplay"
import { Notice, StatusBadge, Timeline } from "../ui"
import { PaymentTimestamp } from "./PaymentTimestamp"
import { ProviderBadge } from "./ProviderBadge"

const KIND_LABELS: Record<Leg["kind"], string> = {
	collect: "Collect",
	convert: "Convert",
	settle: "Settle",
	payout: "Payout",
}

/**
 * Payment-detail journey. Provider labels and Simulated/Sandbox badges come from
 * the shared helper. Processing legs show "Waiting for …" while the detail poller
 * is active.
 */
export function LegTimeline({
	legs,
	events = [],
	polling = false,
}: {
	legs: Leg[]
	events?: Event[]
	/** Detail screen is auto-refreshing every 10s for a processing leg. */
	polling?: boolean
}) {
	if (legs.length === 0) {
		return (
			<div className="empty-state">
				<p className="empty-state__title">No legs yet</p>
				<p className="empty-state__body">
					The route&apos;s legs appear here as soon as the payment reaches them.
				</p>
			</div>
		)
	}

	return (
		<Timeline>
			{legs.map((leg) => {
				const when = legEventTime(events, leg)
				const waiting = polling && leg.status === "processing"
				const label = providerLabel(leg.providerId)
				return (
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
								<ProviderBadge
									simulated={leg.simulated}
									providerId={leg.providerId}
								/>
							</div>
							{waiting ? (
								<>
									<p
										className="timeline__waiting"
										data-testid={`leg-waiting-${leg.kind}`}
									>
										Waiting for {label}
									</p>
									<p className="timeline__note" data-testid="leg-polling-note">
										Checking every 10 s
									</p>
								</>
							) : (
								<p
									className="timeline__when"
									data-testid={`payment-leg-time-${leg.kind}`}
								>
									<PaymentTimestamp iso={when} />
								</p>
							)}
							<p className="timeline__meta">
								<span>{label}</span>
								{leg.rail !== leg.providerId ? (
									<>
										<span aria-hidden="true"> · </span>
										<code className="code-text">{leg.rail}</code>
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
									Reversal of{" "}
									<code className="code-text">{leg.reversalOf}</code>
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
									Release tx{" "}
									<code className="code-text">{leg.releaseTxRef}</code>
								</p>
							) : null}
							{leg.error ? (
								<Notice tone="warning">
									{leg.error.code}: {leg.error.message}
								</Notice>
							) : null}
						</div>
					</li>
				)
			})}
		</Timeline>
	)
}
