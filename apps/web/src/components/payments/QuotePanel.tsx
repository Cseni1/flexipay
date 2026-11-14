import { type Delivery, type Quote } from "@flexipay/web-lib/contract"
import {
	computeAggregatorSaving,
	formatQuoteSavingLine,
} from "../../payments/aggregatorSaving"
import {
	displayFeesTotal,
	displayMoney,
	formatQuoteReason,
} from "../../payments/quoteDisplay"
import { plainStep, rateLine } from "../../payments/quotePlain"
import "../../styles/pages/quote.css"
import {
	Button,
	EmptyState,
	Notice,
	Panel,
	SimulatedLabel,
	StaticField,
} from "../ui"
import { Icon } from "../ui/Icon"
import { WhyThisRoutePanel } from "./WhyThisRoutePanel"

interface QuotePanelProps {
	quote: Quote | null
	delivery: Delivery
	onCreate: () => void
	creating: boolean
	authBlocked: boolean
	expired: boolean
	validityLabel: string
	createError: string | null
	/** Recipient name from step 1, used for "Maria gets". */
	recipientName?: string
}

const KIND_LABELS = {
	collect: "Collect",
	convert: "Convert",
	settle: "Settle",
	payout: "Payout",
} as const

const firstName = (name?: string): string | null => {
	const first = name?.trim().split(/\s+/)[0]
	return first ? first : null
}

export function QuotePanel({
	quote,
	delivery,
	onCreate,
	creating,
	authBlocked,
	expired,
	validityLabel,
	createError,
	recipientName,
}: QuotePanelProps) {
	const who = firstName(recipientName)
	const saving = quote ? computeAggregatorSaving(quote) : null
	const routesCompared = quote ? quote.alternatives.length + 1 : 0
	const rate = quote ? rateLine(quote) : null
	return (
		<Panel
			title="Your price"
			description="We compare our partners and show the best way to get the money there."
			actions={<SimulatedLabel />}
		>
			{!quote ? (
				<EmptyState title="No quote yet">
					Fill in the three steps and tap Get quote. Your price shows up here.
					Nothing is paid until you confirm.
				</EmptyState>
			) : (
				<div className="quote">
					<div className="quote-hero" data-testid="quote-hero">
						<p className="quote-hero__label">
							{who ? `${who} gets` : "They get"}
						</p>
						<p className="quote-hero__amount">
							{displayMoney(
								quote.expectedReceive.amount,
								quote.expectedReceive.currency,
							)}
						</p>
						<dl className="quote-hero__facts">
							<div>
								<dt>You send</dt>
								<dd>
									{displayMoney(
										quote.amount.value.amount,
										quote.amount.value.currency,
									)}
								</dd>
							</div>
							<div>
								<dt>Fees</dt>
								<dd>{displayFeesTotal(quote.fees)}</dd>
							</div>
							{rate ? (
								<div>
									<dt>Rate</dt>
									<dd>{rate}</dd>
								</div>
							) : null}
						</dl>
					</div>

					{saving ? (
						<div className="quote-win" data-testid="aggregator-saving">
							<span className="quote-win__icon" aria-hidden="true">
								<Icon name="check" size={18} />
							</span>
							<p>
								<strong>
									We compared {routesCompared} routes. This one wins.
								</strong>
								<span>{formatQuoteSavingLine(saving)}</span>
							</p>
						</div>
					) : routesCompared > 1 ? (
						<div className="quote-win" data-testid="quote-compared">
							<span className="quote-win__icon" aria-hidden="true">
								<Icon name="check" size={18} />
							</span>
							<p>
								<strong>We compared {routesCompared} routes.</strong>
								<span>This one delivers the most.</span>
							</p>
						</div>
					) : null}

					<section className="quote-steps" aria-labelledby="quote-how">
						<h4 className="quote-section__title" id="quote-how">
							How it gets there
						</h4>
						<ol>
							{quote.route.map((leg, index) => (
								<li key={`${leg.kind}-${leg.rail}-${index}`}>
									<span className="quote-steps__dot">{index + 1}</span>
									<span>{plainStep(leg, quote)}</span>
								</li>
							))}
						</ol>
					</section>

					<Notice tone={expired ? "warning" : "info"}>
						{expired
							? "This quote has expired. Get a new quote before you continue."
							: `This price is held for ${validityLabel}.`}
					</Notice>

					<p
						className="form-note quote-delivery-summary"
						data-testid="quote-delivery"
					>
						{delivery === "claim_link"
							? "They get a link and type in their own account details."
							: "Paid straight to the account you entered."}
					</p>

					{createError ? <Notice tone="warning">{createError}</Notice> : null}

					<div className="form-actions">
						<Button
							disabled={expired || creating || authBlocked}
							onClick={onCreate}
							data-testid="create-payment"
						>
							{creating
								? "Creating…"
								: authBlocked
									? "Authentication required"
									: "Create payment"}
						</Button>
						<span className="form-note">
							{creating
								? "Just a moment…"
								: "Nothing is paid yet. Next you'll see how to pay."}
						</span>
					</div>

					<details className="quote-tech" data-testid="quote-technical-details">
						<summary className="quote-tech__summary">
							<span className="quote-tech__icon" aria-hidden="true">
								<Icon name="code" size={16} />
							</span>
							<span className="quote-tech__title">Technical details</span>
							<span className="quote-tech__hint">Every leg, fee and route</span>
						</summary>
						<div className="quote-tech__body">
							<div className="quote-summary">
								<StaticField
									label="Send"
									value={displayMoney(
										quote.amount.value.amount,
										quote.amount.value.currency,
									)}
									hint={`Amount side: ${quote.amount.side}`}
								/>
								<StaticField
									label="Expected receive"
									value={displayMoney(
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
								<StaticField
									label="Vault fee payer"
									value={quote.feeMode ?? "No vault fee (no settle leg)"}
									hint={
										quote.feeMode
											? "The accepted quote carries this mode into payment creation."
											: undefined
									}
								/>
							</div>

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
												<p className="route-leg__kind">
													{KIND_LABELS[leg.kind]}
												</p>
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
											<span>
												{displayMoney(fee.fee.amount, fee.fee.currency)}
											</span>
										</li>
									))}{" "}
									<li>
										<span>FlexiPay fee</span>
										<span>
											{displayMoney(
												quote.fees.flexiPayFee.amount,
												quote.fees.flexiPayFee.currency,
											)}
										</span>
									</li>
									{quote.fees.settleUnlockedRemainder ? (
										<li>
											<span>Unlocked remainder</span>
											<span>
												{displayMoney(
													quote.fees.settleUnlockedRemainder.amount,
													quote.fees.settleUnlockedRemainder.currency,
												)}
											</span>
										</li>
									) : null}
									<li className="reason-list__total">
										<span>All fees</span>
										<span>{displayFeesTotal(quote.fees)}</span>
									</li>
								</ul>
							</section>

							<WhyThisRoutePanel quote={quote} />

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
													{displayMoney(
														alternative.totalCost.amount,
														alternative.totalCost.currency,
													)}{" "}
													· {alternative.estimatedTimeSeconds}s
												</span>
												{alternative.reasons.length > 0 ? (
													<span className="reason-list__detail">
														{alternative.reasons
															.map((reason) => formatQuoteReason(reason))
															.join(" ")}
													</span>
												) : null}
											</li>
										))}
									</ul>
								)}
							</section>
						</div>
					</details>
				</div>
			)}
		</Panel>
	)
}
