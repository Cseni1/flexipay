import { formatMoney } from "@flexipay/web-lib"
import { type Delivery, type Quote } from "@flexipay/web-lib/contract"
import {
	Button,
	EmptyState,
	Notice,
	Panel,
	SimulatedLabel,
	StaticField,
} from "../ui"

interface QuotePanelProps {
	quote: Quote | null
	delivery: Delivery
	onDeliveryChange: (delivery: Delivery) => void
	onCreate: () => void
	creating: boolean
	expired: boolean
	validityLabel: string
	createError: string | null
}

const KIND_LABELS = {
	collect: "Collect",
	convert: "Convert",
	settle: "Settle",
	payout: "Payout",
} as const

export function QuotePanel({
	quote,
	delivery,
	onDeliveryChange,
	onCreate,
	creating,
	expired,
	validityLabel,
	createError,
}: QuotePanelProps) {
	return (
		<Panel
			title="Quote"
			description="The server chooses the route and returns its fees, FX and validity."
			actions={<SimulatedLabel />}
		>
			{!quote ? (
				<EmptyState title="No quote yet">
					Enter a destination and amount, then request a quote. Nothing is
					created until you confirm.
				</EmptyState>
			) : (
				<div className="quote">
					<div className="quote-summary">
						<StaticField
							label="Send"
							value={formatMoney(
								quote.amount.value.amount,
								quote.amount.value.currency,
							)}
							hint={`Amount side: ${quote.amount.side}`}
						/>
						<StaticField
							label="Expected receive"
							value={formatMoney(
								quote.expectedReceive.amount,
								quote.expectedReceive.currency,
							)}
						/>
						<StaticField
							label="FX rate"
							value={quote.fxRate ?? "No conversion"}
							hint={quote.fxRate ? "Server-provided rate" : undefined}
						/>
						<StaticField
							label="Price risk"
							value={quote.priceRiskBearer}
							hint="The sender bears price movement in this demo."
						/>
					</div>

					<Notice tone={expired ? "warning" : "info"}>
						{expired
							? "This quote has expired. Request a new quote before creating the payment."
							: `Quote is valid for ${validityLabel}.`}
					</Notice>

					<section className="quote-section" aria-labelledby="quote-route">
						<h4 className="quote-section__title" id="quote-route">
							Chosen route
						</h4>
						<ol className="route-list">
							{quote.route.map((leg, index) => (
								<li
									className="route-leg"
									key={`${leg.kind}-${leg.rail}-${index}`}
								>
									<span className="route-leg__index">{index + 1}</span>
									<div>
										<p className="route-leg__kind">{KIND_LABELS[leg.kind]}</p>
										<p className="route-leg__rail">
											<code className="code-text">{leg.rail}</code>
											{leg.rail !== leg.providerId ? (
												<>
													<span aria-hidden="true"> · </span>
													{leg.providerId}
												</>
											) : null}
										</p>
									</div>
									{leg.simulated ? <SimulatedLabel /> : null}
								</li>
							))}
						</ol>
					</section>

					<section className="quote-section" aria-labelledby="quote-fees">
						<h4 className="quote-section__title" id="quote-fees">
							Fees
						</h4>
						<ul className="reason-list">
							{quote.fees.legs.map((fee, index) => (
								<li key={`${fee.kind}-${fee.rail}-${index}`}>
									<span>
										{KIND_LABELS[fee.kind]}{" "}
										<code className="code-text">{fee.rail}</code>
									</span>
									<span>{formatMoney(fee.fee.amount, fee.fee.currency)}</span>
								</li>
							))}
							<li>
								<span>FlexiPay fee</span>
								<span>
									{formatMoney(
										quote.fees.flexiPayFee.amount,
										quote.fees.flexiPayFee.currency,
									)}
								</span>
							</li>
							<li className="reason-list__total">
								<span>All fees</span>
								<span>
									{formatMoney(
										quote.fees.total.amount,
										quote.fees.total.currency,
									)}
								</span>
							</li>
						</ul>
					</section>

					<section className="quote-section" aria-labelledby="quote-reasons">
						<h4 className="quote-section__title" id="quote-reasons">
							Why this route?
						</h4>
						{quote.reasons.length === 0 ? (
							<p className="muted">No additional reasons were returned.</p>
						) : (
							<ul className="reason-list reason-list--text">
								{quote.reasons.map((reason) => (
									<li key={reason}>{reason}</li>
								))}
							</ul>
						)}
					</section>

					<section
						className="quote-section"
						aria-labelledby="quote-alternatives"
					>
						<h4 className="quote-section__title" id="quote-alternatives">
							Other eligible routes
						</h4>
						{quote.alternatives.length === 0 ? (
							<p className="muted">
								No alternative eligible route was returned.
							</p>
						) : (
							<ul className="reason-list reason-list--text">
								{quote.alternatives.map((alternative, index) => (
									<li key={`alternative-${index}`}>
										<span>
											{alternative.route.map((leg) => leg.rail).join(" → ")}
										</span>
										<span>
											{formatMoney(
												alternative.totalCost.amount,
												alternative.totalCost.currency,
											)}{" "}
											· {alternative.estimatedTimeSeconds}s
										</span>
										{alternative.reasons.length > 0 ? (
											<span className="reason-list__detail">
												{alternative.reasons.join(" ")}
											</span>
										) : null}
									</li>
								))}
							</ul>
						)}
					</section>

					<fieldset className="option-list quote-delivery">
						<legend className="field__label">Delivery</legend>
						<label className="option-card">
							<input
								type="radio"
								name="delivery"
								value="direct"
								checked={delivery === "direct"}
								onChange={() => onDeliveryChange("direct")}
							/>
							<span className="option-card__body">
								<span className="option-card__title">Direct to recipient</span>
								<span className="option-card__detail">
									Send to the recipient's chosen endpoint.
								</span>
							</span>
						</label>
						<label className="option-card">
							<input
								type="radio"
								name="delivery"
								value="claim_link"
								checked={delivery === "claim_link"}
								onChange={() => onDeliveryChange("claim_link")}
							/>
							<span className="option-card__body">
								<span className="option-card__title">Claim link</span>
								<span className="option-card__detail">
									Share a link so the recipient chooses how to receive it.
								</span>
							</span>
						</label>
					</fieldset>

					{createError ? <Notice tone="warning">{createError}</Notice> : null}

					<div className="form-actions">
						<Button disabled={expired || creating} onClick={onCreate}>
							{creating ? "Creating…" : "Create payment"}
						</Button>
						<span className="form-note">
							{creating
								? "A second click is ignored while the payment is created."
								: "Creation uses an Idempotency-Key; funding happens on the detail screen."}
						</span>
					</div>
				</div>
			)}
		</Panel>
	)
}
