import { Link } from "react-router-dom"
import { describeApiError, isAuthRequired } from "../api/client"
import { PaymentHistoryTable } from "../components/payments/PaymentHistoryTable"
import {
	Button,
	EmptyState,
	Notice,
	Page,
	Panel,
	SimulatedLabel,
} from "../components/ui"
import { Icon } from "../components/ui/Icon"
import { usePaymentList } from "../hooks/usePaymentList"
import { useLiveMoney } from "../live/LiveMoney"
import {
	sumSavingsByCurrency,
	type AggregatorSaving,
} from "../payments/aggregatorSaving"
import { displayMoney } from "../payments/quoteDisplay"
import { lookupStoredSaving } from "../payments/quoteSavingStore"
import { useSession } from "../providers/SessionProvider"

/** First word of the account name, if it looks like a real name. */
const firstName = (full: string | null): string | null => {
	const first = full?.trim().split(/\s+/)[0]
	return first && /^\p{L}[\p{L}'-]{0,30}$/u.test(first) ? first : null
}

const count = (list: { status: string }[], ...statuses: string[]): number =>
	list.filter((payment) => statuses.includes(payment.status)).length

const savingsForLoadedPayments = (
	payments: { id: string; quoteId: string }[],
): AggregatorSaving[] => {
	const found: AggregatorSaving[] = []
	for (const payment of payments) {
		const saving = lookupStoredSaving({
			paymentId: payment.id,
			quoteId: payment.quoteId,
		})
		if (saving) found.push(saving)
	}
	return found
}

export default function Dashboard() {
	const live = useLiveMoney()
	const { state } = useSession()
	const user = state.status === "signed_in" ? state.session.user : null
	const { payments, error, loading, refresh } = usePaymentList()
	const inFlight = count(
		payments,
		"awaiting_funding",
		"funded",
		"processing",
		"refunding",
	)
	const done = count(payments, "paid", "completed")
	const refunded = count(payments, "refunded")
	const failed = count(payments, "failed")
	const savedTotals = sumSavingsByCurrency(savingsForLoadedPayments(payments))

	const name = firstName(user?.name ?? null)
	return (
		<Page>
			<h2 className="visually-hidden">Dashboard</h2>
			<section className="hero" aria-label="Send money">
				<div>
					<p className="hero__eyebrow">FlexiPay by FlexiWork</p>
					<p className="hero__title">
						{name ? `Hi ${name}, ` : "Hi, "}
						<em>send money anywhere</em> in a few taps.
					</p>
					<p className="hero__text">
						Pick a person, see the price, pay. We compare our partners and pick
						the best way to get the money there.
					</p>
					<div className="hero__actions">
						<Link className="button button--primary" to="/">
							<Icon name="send" size={18} />
							Send money
						</Link>
						<Button variant="secondary" onClick={refresh}>
							Refresh
						</Button>
					</div>
				</div>
				<div className="hero__card">
					<span className="hero__card-label">Delivered so far</span>
					<strong className="hero__card-value">{done}</strong>
					<ol className="hero__steps">
						<li>
							<span className="hero__step-num">1</span>Pick a person
						</li>
						<li>
							<span className="hero__step-num">2</span>See the price
						</li>
						<li>
							<span className="hero__step-num">3</span>Pay. Done.
						</li>
					</ol>
				</div>
			</section>

			<nav className="action-tiles" aria-label="Quick actions">
				<Link to="/" className="action-tile action-tile--main">
					<span className="action-tile__icon">
						<Icon name="send" size={22} />
					</span>
					<span className="action-tile__title">Send money</span>
					<span className="action-tile__text">
						To a bank or wallet in another country
					</span>
				</Link>
				<Link to="/take-payment" className="action-tile">
					<span className="action-tile__icon">
						<Icon name="request" size={22} />
					</span>
					<span className="action-tile__title">Get paid</span>
					<span className="action-tile__text">Show a QR code at your till</span>
				</Link>
				<Link to="/recipients" className="action-tile">
					<span className="action-tile__icon">
						<Icon name="people" size={22} />
					</span>
					<span className="action-tile__title">People</span>
					<span className="action-tile__text">
						Save the people you pay often
					</span>
				</Link>
				<Link to="/where-we-pay" className="action-tile">
					<span className="action-tile__icon">
						<Icon name="globe" size={22} />
					</span>
					<span className="action-tile__title">Where we pay</span>
					<span className="action-tile__text">
						Countries and ways to get paid
					</span>
				</Link>
			</nav>

			{error ? (
				<Notice tone="warning" data-testid="dashboard-error">
					{isAuthRequired(error)
						? "The local web proxy is not signed in to the API. Set FP_API_KEY for the Vite server and restart it."
						: `Could not load payments: ${describeApiError(error)}`}
				</Notice>
			) : null}

			<div className="stat-row" data-testid="dashboard-stats">
				<div className="stat-card">
					<span className="stat-card__label">
						<span className="stat-card__icon">
							<Icon name="activity" size={16} />
						</span>
						All payments
					</span>
					<strong className="stat-card__value">{payments.length}</strong>
				</div>
				<div className="stat-card">
					<span className="stat-card__label">
						<span className="stat-card__icon stat-card__icon--warn">
							<Icon name="clock" size={16} />
						</span>
						On its way
					</span>
					<strong className="stat-card__value">{inFlight}</strong>
				</div>
				<div className="stat-card">
					<span className="stat-card__label">
						<span className="stat-card__icon stat-card__icon--ok">
							<Icon name="check" size={16} />
						</span>
						Delivered
					</span>
					<strong className="stat-card__value">{done}</strong>
				</div>
				<div className="stat-card">
					<span className="stat-card__label">
						<span className="stat-card__icon stat-card__icon--muted">
							<Icon name="back" size={16} />
						</span>
						Money returned
					</span>
					<strong className="stat-card__value">{refunded + failed}</strong>
				</div>
			</div>

			{savedTotals.length > 0 ? (
				<div
					className="stat-card dashboard-saved"
					data-testid="dashboard-saved-for-recipients"
				>
					<span className="stat-card__label">Saved for recipients</span>
					<strong className="stat-card__value">
						{savedTotals
							.map((total) => displayMoney(total.amount, total.currency))
							.join(" · ")}
					</strong>
				</div>
			) : null}

			<Panel
				title="Recent activity"
				description="Tap a payment to follow it step by step."
				actions={<SimulatedLabel />}
				footer={<Link to="/payments">See all activity</Link>}
			>
				{loading ? (
					<p className="form-note">Loading payments...</p>
				) : payments.length === 0 ? (
					<EmptyState title="No payments yet">
						Tap Send money to make your first one.
					</EmptyState>
				) : (
					<PaymentHistoryTable payments={payments.slice(0, 6)} />
				)}
			</Panel>

			<Panel
				title="What works today, and what is next"
				description={
					live
						? "Live money on Solana mainnet. Simulated partners are hidden."
						: "Everything here runs on partner sandboxes and Solana devnet. Nothing moves real money yet."
				}
				actions={<SimulatedLabel>Roadmap</SimulatedLabel>}
			>
				<ul className="roadmap-list" data-testid="dashboard-roadmap">
					{ROADMAP.map((item) => (
						<li key={item.title} className="roadmap-list__item">
							<span className="roadmap-list__title">{item.title}</span>
							{item.status === "working" ? (
								<span className="roadmap-list__status roadmap-list__status--working">
									{live ? "Working" : "Working (sandbox)"}
								</span>
							) : (
								<SimulatedLabel>Coming soon</SimulatedLabel>
							)}
						</li>
					))}
				</ul>
			</Panel>
		</Page>
	)
}

/** Demo roadmap: only items the founder has confirmed; "working" means proven end to end on sandboxes. */
const ROADMAP: ReadonlyArray<{ title: string; status: "working" | "soon" }> = [
	{ title: "Quotes from pounds to 63 countries (Tazapay)", status: "working" },
	{
		title: "Compare partners and pick the route that delivers the most",
		status: "working",
	},
	{
		title:
			"Bank payouts from dollars: Philippines (Tazapay), Brazil (BlindPay)",
		status: "working",
	},
	{ title: "Recipients with saved bank accounts", status: "working" },
	{
		title: "Take payment: till QR in tGBP (Solana devnet; phone test pending)",
		status: "working",
	},
	{ title: "Bank payouts from pounds via tGBP on Solana", status: "soon" },
	{
		title: "FlexiPay wallet (embedded) to hold tGBP and pay by QR",
		status: "soon",
	},
	{ title: "Merchant cash-out to their bank account", status: "soon" },
	{ title: "Card and bank top-up", status: "soon" },
	{ title: "Real money with production partners", status: "soon" },
]
