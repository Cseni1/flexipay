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
							<th>Payment</th>
							<th>Created</th>
							<th>To</th>
							<th>Delivery</th>
							<th>Route ends at</th>
							<th>Status</th>
							<th className="num">Amount</th>
							<th className="num">Saved</th>
						</tr>
					</thead>
					<tbody>
						{payments.map((payment) => {
							const saving = savingFor(payment)
							return (
								<tr key={payment.id}>
									<td>
										<Link to={`/payments/${encodeURIComponent(payment.id)}`}>
											<code className="code-text">{payment.id}</code>
										</Link>
									</td>
									<td>
										<PaymentTimestamp iso={payment.createdAt} />
									</td>
									<td data-testid="payment-history-to">
										{recipientDisplayName(names, payment.recipientId)}
									</td>
									<td>
										{payment.delivery === "claim_link"
											? "Claim link"
											: "Direct"}
									</td>
									<td>{routeEndsAt(payment)}</td>
									<td>
										<StatusBadge status={payment.status} />
									</td>
									<td className="num">{firstAmount(payment)}</td>
									<td className="num">
										{saving ? (
											<span data-testid="payment-saving">
												{formatPaymentSavingLine(saving)}
											</span>
										) : (
											"—"
										)}
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
									<span>
										{recipientDisplayName(names, payment.recipientId)}
									</span>
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
									<span className="history-card__label">Status</span>
									<StatusBadge status={payment.status} />
								</div>
							</Link>
						</li>
					)
				})}
			</ul>
		</>
	)
}
