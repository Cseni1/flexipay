import { type Payment } from "@flexipay/web-lib/contract"
import { Link } from "react-router-dom"
import {
	recipientDisplayName,
	useRecipientDirectory,
} from "../../hooks/useRecipientDirectory"
import {
	formatPaymentSavingLine,
	type AggregatorSaving,
} from "../../payments/aggregatorSaving"
import { providerLabel } from "../../payments/providerNames"
import { displayMoney } from "../../payments/quoteDisplay"
import { lookupStoredSaving } from "../../payments/quoteSavingStore"
import { StatusBadge } from "../ui"
import { PaymentTimestamp } from "./PaymentTimestamp"

const firstAmount = (payment: Payment): string => {
	const leg = payment.legs[0]
	return leg ? displayMoney(leg.amountIn.amount, leg.amountIn.currency) : "-"
}

const routeEndsAt = (payment: Payment): string => {
	const leg = payment.legs.at(-1)
	return leg ? providerLabel(leg.providerId || leg.rail) : "-"
}

const initial = (name: string): string =>
	(name.trim().match(/\p{L}|\d/u)?.[0] ?? "?").toUpperCase()

const savingFor = (payment: Payment): AggregatorSaving | null =>
	lookupStoredSaving({ paymentId: payment.id, quoteId: payment.quoteId })

export function PaymentHistoryTable({ payments }: { payments: Payment[] }) {
	const { names } = useRecipientDirectory()

	return (
		<>
			<div className="table-scroll history-table-wrap">
				<table className="history-table" data-testid="payment-history">
					<thead>
						<tr>
							<th>To</th>
							<th className="num">Amount</th>
							<th>Status</th>
							<th>When</th>
							<th>Via</th>
							<th className="num">Saved</th>
							<th>Reference</th>
						</tr>
					</thead>
					<tbody>
						{payments.map((payment) => {
							const saving = savingFor(payment)
							const name = recipientDisplayName(names, payment.recipientId)
							return (
								<tr key={payment.id}>
									<td data-testid="payment-history-to">
										<span className="person">
											<span className="person__avatar" aria-hidden="true">
												{initial(name)}
											</span>
											{name}
										</span>
									</td>
									<td className="num history-table__amount">
										{firstAmount(payment)}
									</td>
									<td>
										<StatusBadge status={payment.status} />
									</td>
									<td>
										<PaymentTimestamp iso={payment.createdAt} />
									</td>
									<td>
										{routeEndsAt(payment)}
										{payment.delivery === "claim_link" ? " · claim link" : ""}
									</td>
									<td className="num">
										{saving ? (
											<span data-testid="payment-saving">
												{formatPaymentSavingLine(saving)}
											</span>
										) : (
											"—"
										)}
									</td>
									<td>
										<Link to={`/payments/${encodeURIComponent(payment.id)}`}>
											<code className="code-text">{payment.id}</code>
										</Link>
									</td>
								</tr>
							)
						})}
					</tbody>
				</table>
			</div>

			<ul
				className="history-cards"
				data-testid="payment-history-cards"
				aria-label="Payments"
			>
				{payments.map((payment) => {
					const saving = savingFor(payment)
					return (
						<li key={payment.id} className="history-card">
							<Link
								className="history-card__link"
								to={`/payments/${encodeURIComponent(payment.id)}`}
							>
								<div className="history-card__head">
									<span className="person">
										<span className="person__avatar" aria-hidden="true">
											{initial(
												recipientDisplayName(names, payment.recipientId),
											)}
										</span>
										{recipientDisplayName(names, payment.recipientId)}
									</span>
									<StatusBadge status={payment.status} />
								</div>
								<div className="history-card__row">
									<span className="history-card__label">When</span>
									<PaymentTimestamp iso={payment.createdAt} />
								</div>
								<div className="history-card__row">
									<span className="history-card__label">Amount</span>
									<strong className="history-card__amount">
										{firstAmount(payment)}
									</strong>
								</div>
								{saving ? (
									<div className="history-card__row">
										<span className="history-card__label">Saved</span>
										<span data-testid="payment-saving">
											{formatPaymentSavingLine(saving)}
										</span>
									</div>
								) : null}
								<div className="history-card__row">
									<span className="history-card__label">Reference</span>
									<code className="code-text">{payment.id}</code>
								</div>
							</Link>
						</li>
					)
				})}
			</ul>
		</>
	)
}
