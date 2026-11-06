import { type Payment } from "@flexipay/web-lib/contract"
import { Link } from "react-router-dom"
import {
	recipientDisplayName,
	useRecipientDirectory,
} from "../../hooks/useRecipientDirectory"
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

export function PaymentHistoryTable({ payments }: { payments: Payment[] }) {
	const { names } = useRecipientDirectory()

	return (
		<div className="table-scroll">
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
							<td data-testid="payment-history-to">
								{recipientDisplayName(names, payment.recipientId)}
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
	)
}
