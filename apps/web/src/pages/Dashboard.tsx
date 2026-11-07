import { Link } from "react-router-dom"
import { describeApiError, isAuthRequired } from "../api/client"
import { PaymentHistoryTable } from "../components/payments/PaymentHistoryTable"
import {
	Button,
	EmptyState,
	Notice,
	Page,
	PageHeader,
	Panel,
	SimulatedLabel,
} from "../components/ui"
import { usePaymentList } from "../hooks/usePaymentList"
import {
	sumSavingsByCurrency,
	type AggregatorSaving,
} from "../payments/aggregatorSaving"
import { displayMoney } from "../payments/quoteDisplay"
import { lookupStoredSaving } from "../payments/quoteSavingStore"

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

	return (
		<Page>
			<PageHeader
				eyebrow="Overview"
				title="Dashboard"
				description="Everything you have sent, read live from the API."
				actions={
					<>
						<Button variant="secondary" onClick={refresh}>
							Refresh
						</Button>
						<Link className="button button--primary" to="/">
							New payment
						</Link>
					</>
				}
			/>

			{error ? (
				<Notice tone="warning" data-testid="dashboard-error">
					{isAuthRequired(error)
						? "The local web proxy is not signed in to the API. Set FP_API_KEY for the Vite server and restart it."
						: `Could not load payments: ${describeApiError(error)}`}
				</Notice>
			) : null}

			<div className="stat-row" data-testid="dashboard-stats">
				<div className="stat-card">
					<span className="stat-card__label">Payments</span>
					<strong className="stat-card__value">{payments.length}</strong>
				</div>
				<div className="stat-card">
					<span className="stat-card__label">In flight</span>
					<strong className="stat-card__value">{inFlight}</strong>
				</div>
				<div className="stat-card">
					<span className="stat-card__label">Paid out</span>
					<strong className="stat-card__value">{done}</strong>
				</div>
				<div className="stat-card">
					<span className="stat-card__label">Refunded or failed</span>
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
				title="Recent payments"
				description="Newest first. Select a payment to see its route, events and on-chain references."
				actions={<SimulatedLabel />}
				footer={<Link to="/payments">See the full history</Link>}
			>
				{loading ? (
					<p className="form-note">Loading payments...</p>
				) : payments.length === 0 ? (
					<EmptyState title="No payments yet">
						Create the first one with New payment.
					</EmptyState>
				) : (
					<PaymentHistoryTable payments={payments.slice(0, 6)} />
				)}
			</Panel>

			<Panel
				title="What works today, and what is coming"
				description="Everything here runs on partner sandboxes and Solana devnet. Nothing moves real money yet."
				actions={<SimulatedLabel>Roadmap</SimulatedLabel>}
			>
				<ul className="roadmap-list" data-testid="dashboard-roadmap">
					{ROADMAP.map((item) => (
						<li key={item.title} className="roadmap-list__item">
							<span className="roadmap-list__title">{item.title}</span>
							{item.status === "working" ? (
								<span className="roadmap-list__status roadmap-list__status--working">
									Working (sandbox)
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
