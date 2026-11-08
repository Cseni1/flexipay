import { useState } from "react"
import { Link } from "react-router-dom"
import { describeApiError } from "../api/client"
import { PaymentHistoryTable } from "../components/payments/PaymentHistoryTable"
import { Button, Notice, Page, PageHeader } from "../components/ui"
import { Icon, type IconName } from "../components/ui/Icon"
import { usePaymentList } from "../hooks/usePaymentList"
import {
	recipientDisplayName,
	useRecipientDirectory,
} from "../hooks/useRecipientDirectory"
import "../styles/pages/activity.css"

type Filter = {
	key: string
	label: string
	icon: IconName
	statuses: string[]
}

const FILTERS: Filter[] = [
	{ key: "all", label: "All", icon: "activity", statuses: [] },
	{
		key: "moving",
		label: "On the way",
		icon: "clock",
		statuses: ["awaiting_funding", "funded", "processing", "refunding"],
	},
	{
		key: "done",
		label: "Delivered",
		icon: "check",
		statuses: ["paid", "completed"],
	},
	{
		key: "problem",
		label: "Refunded or failed",
		icon: "alert",
		statuses: ["refunded", "failed", "cancelled"],
	},
]

const matches = (filter: Filter, status: string): boolean =>
	filter.statuses.length === 0 || filter.statuses.includes(status)

export default function PaymentsHistory() {
	const { payments, error, loading, refresh } = usePaymentList()
	const { names } = useRecipientDirectory()
	const [filterKey, setFilterKey] = useState("all")
	const [query, setQuery] = useState("")
	const filter = FILTERS.find((entry) => entry.key === filterKey) ?? FILTERS[0]!
	const needle = query.trim().toLowerCase()
	const shown = payments.filter(
		(payment) =>
			matches(filter, payment.status) &&
			(!needle ||
				payment.id.toLowerCase().includes(needle) ||
				recipientDisplayName(names, payment.recipientId)
					.toLowerCase()
					.includes(needle)),
	)
	const narrowed = filterKey !== "all" || needle !== ""
	const clear = () => {
		setFilterKey("all")
		setQuery("")
	}

	return (
		<Page>
			<PageHeader
				eyebrow="Your money"
				title="Activity"
				description="Every payment you have sent, newest first."
				actions={
					<>
						<Button
							variant="secondary"
							onClick={refresh}
							disabled={loading}
							aria-label="Refresh"
						>
							<Icon name="refresh" size={18} />
							<span className="activity-hide-sm">Refresh</span>
						</Button>
						<Link className="button button--primary" to="/">
							<Icon name="send" size={18} />
							Send money
						</Link>
					</>
				}
			/>
			{error ? (
				<Notice tone="warning">
					Could not load payments: {describeApiError(error)}
				</Notice>
			) : null}

			<section className="panel activity" aria-label="Payments">
				<div className="activity-toolbar">
					<div className="activity-chips" role="group" aria-label="Show">
						{FILTERS.map((entry) => {
							const total = payments.filter((payment) =>
								matches(entry, payment.status),
							).length
							return (
								<button
									key={entry.key}
									type="button"
									className={`activity-chip activity-chip--${entry.key}`}
									aria-pressed={filterKey === entry.key}
									onClick={() => setFilterKey(entry.key)}
								>
									<span className="activity-chip__icon" aria-hidden="true">
										<Icon name={entry.icon} size={15} />
									</span>
									{entry.label}
									{loading ? null : (
										<span className="activity-chip__count" aria-hidden="true">
											{total}
										</span>
									)}
								</button>
							)
						})}
					</div>
					<label className="activity-search">
						<Icon name="search" size={18} />
						<input
							type="search"
							placeholder="Search by name or reference"
							aria-label="Search payments"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</label>
				</div>

				<div className="activity-body">
					{loading ? (
						<div className="activity-loading" aria-live="polite">
							<span className="visually-hidden">Loading payments...</span>
							{[0, 1, 2, 3].map((key) => (
								<span key={key} className="activity-ghost" />
							))}
						</div>
					) : error && payments.length === 0 ? null : shown.length === 0 ? (
						<div className="activity-empty">
							<span className="activity-empty__icon" aria-hidden="true">
								<Icon name={narrowed ? "search" : "send"} size={26} />
							</span>
							{narrowed ? (
								<>
									<p className="activity-empty__title">No payments match</p>
									<p className="activity-empty__text">
										Try another word, or show everything.
									</p>
									<Button variant="secondary" onClick={clear}>
										Show all payments
									</Button>
								</>
							) : (
								<>
									<p className="activity-empty__title">No payments yet</p>
									<p className="activity-empty__text">
										When you send money, it shows up here.
									</p>
									<Link className="button button--primary" to="/">
										<Icon name="send" size={18} />
										Send your first payment
									</Link>
								</>
							)}
						</div>
					) : (
						<>
							<p className="activity-count" aria-live="polite">
								{narrowed
									? `Showing ${shown.length} of ${payments.length}`
									: shown.length === 1
										? "1 payment"
										: `${shown.length} payments`}
							</p>
							<PaymentHistoryTable payments={shown} />
						</>
					)}
				</div>
			</section>
		</Page>
	)
}
