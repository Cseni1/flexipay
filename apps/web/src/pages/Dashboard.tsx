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
		</Page>
	)
}
