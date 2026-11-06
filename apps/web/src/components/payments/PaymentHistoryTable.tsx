import { type Payment } from "@flexipay/web-lib/contract"
import { Link } from "react-router-dom"
import { displayMoney } from "../../payments/quoteDisplay"
import { StatusBadge } from "../ui"
import { PaymentTimestamp } from "./PaymentTimestamp"

const firstAmount = (payment: Payment): string => {
	const leg = payment.legs[0]
	return leg ? displayMoney(leg.amountIn.amount, leg.amountIn.currency) : "-"
}

const lastLeg = (payment: Payment): string => {
	const leg = payment.legs.at(-1)
	return leg ? leg.rail : "-"
}

const toLabel = (payment: Payment): string =>
	payment.recipientId?.trim() || lastLeg(payment)

export function PaymentHistoryTable({ payments }: { payments: Payment[] }) {
	return (
		<>
			<div className="table-scroll history-table-wrap">
				<table className="history-table" data-testid="payment-history">
					<thead>
						<tr>
							<th>Payment</th>
							<th>Created</th>
							<th>Delivery</th>
							<th>Route ends at</th>
							<th>Status</th>
							<th className="num">Amount</th>
						</tr>
					</thead>
					<tbody>
						{payments.map((payment) => (
							<tr key={payment.id}>
								<td>
									<Link to={`/payments/${encodeURIComponent(payment.id)}`}>
										<code className="code-text">{payment.id}</code>
									</Link>
								</td>
								<td>
									<PaymentTimestamp iso={payment.createdAt} />
								</td>
								<td>
									{payment.delivery === "claim_link" ? "Claim link" : "Direct"}
								</td>
								<td>{lastLeg(payment)}</td>
								<td>
									<StatusBadge status={payment.status} />
								</td>
								<td className="num">{firstAmount(payment)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<ul
				className="history-cards"
				data-testid="payment-history-cards"
				aria-label="Payments"
			>
				{payments.map((payment) => (
					<li key={payment.id} className="history-card">
						<Link
							className="history-card__link"
							to={`/payments/${encodeURIComponent(payment.id)}`}
						>
							<div className="history-card__row">
								<span className="history-card__label">Payment</span>
								<code className="code-text">{payment.id}</code>
							</div>
							<div className="history-card__row">
								<span className="history-card__label">Created</span>
								<PaymentTimestamp iso={payment.createdAt} />
							</div>
							<div className="history-card__row">
								<span className="history-card__label">To</span>
								<code className="code-text">{toLabel(payment)}</code>
							</div>
							<div className="history-card__row">
								<span className="history-card__label">Amount</span>
								<strong className="history-card__amount">
									{firstAmount(payment)}
								</strong>
							</div>
							<div className="history-card__row">
								<span className="history-card__label">Status</span>
								<StatusBadge status={payment.status} />
							</div>
						</Link>
					</li>
				))}
			</ul>
		</>
	)
}
