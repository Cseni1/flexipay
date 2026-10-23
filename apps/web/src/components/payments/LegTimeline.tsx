import { formatMoney } from "@flexipay/web-lib"
import { type Leg } from "@flexipay/web-lib/contract"
import {
	Notice,
	SimulatedLabel,
	StatusBadge,
	Timeline,
	TimelineItem,
} from "../ui"

const KIND_LABELS: Record<Leg["kind"], string> = {
	collect: "Collect",
	convert: "Convert",
	settle: "Settle",
	payout: "Payout",
}

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
				<TimelineItem
					key={leg.id}
					title={KIND_LABELS[leg.kind]}
					status={<StatusBadge status={leg.status} />}
					meta={
						<>
							<code className="code-text">{leg.rail}</code>
							{leg.rail !== leg.providerId ? (
								<>
									<span aria-hidden="true"> · </span>
									{leg.providerId}
								</>
							) : null}
						</>
					}
				>
					<p className="timeline__amounts">
						<span>
							{formatMoney(leg.amountIn.amount, leg.amountIn.currency)}
						</span>
						<span className="timeline__arrow" aria-hidden="true">
							→
						</span>
						<span>
							{formatMoney(leg.amountOut.amount, leg.amountOut.currency)}
						</span>
					</p>
					{leg.reversalOf ? (
						<p className="timeline__note">
							Reversal of <code className="code-text">{leg.reversalOf}</code>
						</p>
					) : null}
					{leg.externalRef ? (
						<p className="timeline__reference">
							Reference <code className="code-text">{leg.externalRef}</code>
						</p>
					) : null}
					{leg.error ? (
						<Notice tone="warning">
							{leg.error.code}: {leg.error.message}
						</Notice>
					) : null}
					{leg.simulated ? <SimulatedLabel /> : null}
				</TimelineItem>
			))}
		</Timeline>
	)
}
