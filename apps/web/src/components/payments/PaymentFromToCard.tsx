import { type Event } from "@flexipay/web-lib/contract"
import { type EndpointSummary } from "../../api/client"
import {
	formatDestinationLabel,
	onchainDestinationFromEvents,
	payerFromEvents,
} from "../../payments/paymentParties"
import { shortAddress } from "../../solana/walletStandard"
import { Panel } from "../ui"

type Props = {
	senderName: string
	recipientName: string
	events: readonly Event[]
	endpoint?: EndpointSummary | null
}

/**
 * Clear From / To summary for payment detail: organisation (and paying wallet
 * when known), recipient name, and destination (wallet short form or masked bank).
 */
export function PaymentFromToCard({
	senderName,
	recipientName,
	events,
	endpoint = null,
}: Props) {
	const payer = payerFromEvents(events)
	const destination = formatDestinationLabel(
		endpoint,
		onchainDestinationFromEvents(events),
	)

	return (
		<div data-testid="payment-from-to">
			<Panel
				title="From / To"
				description="Who sent this payment and where it is going."
			>
				<div className="from-to" data-testid="payment-from-to-body">
					<div className="from-to__side">
						<p className="from-to__label">From</p>
						<p className="from-to__name" data-testid="payment-from-name">
							{senderName}
						</p>
						{payer ? (
							<p className="from-to__meta" data-testid="payment-from-wallet">
								Paying wallet{" "}
								<code className="code-text" title={payer}>
									{shortAddress(payer)}
								</code>
							</p>
						) : (
							<p className="from-to__meta muted">
								Paying wallet unknown until an on-chain settle is recorded.
							</p>
						)}
					</div>
					<div className="from-to__arrow" aria-hidden="true">
						→
					</div>
					<div className="from-to__side">
						<p className="from-to__label">To</p>
						<p className="from-to__name" data-testid="payment-to-name">
							{recipientName}
						</p>
						<p className="from-to__meta" data-testid="payment-to-destination">
							Destination <code className="code-text">{destination}</code>
						</p>
					</div>
				</div>
			</Panel>
		</div>
	)
}
