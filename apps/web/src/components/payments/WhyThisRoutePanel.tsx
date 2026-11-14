import { type Quote } from "@flexipay/web-lib/contract"
import { formatQuoteReason } from "../../payments/quoteDisplay"
import { buildWhyThisRoute } from "../../payments/whyThisRoute"

type Props = {
	quote: Quote
}

/**
 * Plain-English route explanation after a quote: chosen provider per leg,
 * alternatives from the quote API, and Simulated/Sandbox badges.
 */
export function WhyThisRoutePanel({ quote }: Props) {
	const lines = buildWhyThisRoute(quote)
	return (
		<section
			className="quote-section why-route"
			aria-labelledby="quote-why-route"
			data-testid="why-this-route"
		>
			<h4 className="quote-section__title" id="quote-why-route">
				Why this route
			</h4>
			<ul className="why-route__list">
				{lines.map((line, index) => (
					<li
						key={`${line.kind}-${line.chosenProvider}-${index}`}
						className="why-route__row"
					>
						<p className="why-route__sentence">{line.sentence}</p>
						<span
							className={`provider-badge provider-badge--${line.chosenBadge.toLowerCase()}`}
							data-testid="provider-badge"
						>
							{line.chosenBadge}
						</span>
						{line.others.map((other) => (
							<span
								key={`${line.kind}-${other.provider}`}
								className={`provider-badge provider-badge--${other.badge.toLowerCase()}`}
								data-testid="provider-badge"
							>
								{other.badge}
							</span>
						))}
					</li>
				))}
			</ul>
			{quote.reasons.length > 0 ? (
				<ul className="reason-list reason-list--text why-route__reasons">
					{quote.reasons.map((reason) => (
						<li key={reason}>{formatQuoteReason(reason)}</li>
					))}
				</ul>
			) : null}
		</section>
	)
}
