import { useState } from "react"
import { Link } from "react-router-dom"
import { describeApiError } from "../api/client"
import { PaymentHistoryTable } from "../components/payments/PaymentHistoryTable"
import {
	Button,
	EmptyState,
	Notice,
	Page,
	PageHeader,
	Panel,
} from "../components/ui"
import { usePaymentList } from "../hooks/usePaymentList"

const FILTERS: [string, string, string[]][] = [
	["all", "All", []],
	[
		"moving",
		"In flight",
		["awaiting_funding", "funded", "processing", "refunding"],
	],
	["done", "Paid out", ["paid", "completed"]],
	["problem", "Refunded or failed", ["refunded", "failed", "cancelled"]],
]

export default function PaymentsHistory() {
	const { payments, error, loading, refresh } = usePaymentList()
	const [filter, setFilter] = useState("all")
	const [query, setQuery] = useState("")
	const statuses = FILTERS.find(([key]) => key === filter)?.[2] ?? []
	const shown = payments.filter(
		(payment) =>
			(statuses.length === 0 || statuses.includes(payment.status)) &&
			(!query || payment.id.toLowerCase().includes(query.toLowerCase())),
	)

	return (
		<Page>
			<PageHeader
				eyebrow="History"
				title="Payments"
				description="Every payment, newest first."
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
				<Notice tone="warning">
					Could not load payments: {describeApiError(error)}
				</Notice>
			) : null}
			<Panel>
				<div className="filter-row">
					{FILTERS.map(([key, label]) => (
						<button
							key={key}
							type="button"
							className="filter-chip"
							aria-pressed={filter === key}
							onClick={() => setFilter(key)}
						>
							{label}
						</button>
					))}
					<input
						type="search"
						className="filter-search"
						placeholder="Search by payment id"
						aria-label="Search payments"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</div>
				{loading ? (
					<p className="form-note">Loading payments...</p>
				) : shown.length === 0 ? (
					<EmptyState title="No payments match">
						Change the filter or create a new payment.
					</EmptyState>
				) : (
					<PaymentHistoryTable payments={shown} />
				)}
			</Panel>
		</Page>
	)
}
