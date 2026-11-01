import { formatMoney } from "@flexipay/web-lib"
import { type Payment } from "@flexipay/web-lib/contract"
import { Link } from "react-router-dom"
import { StatusBadge } from "../ui"

const when = (iso: string): string =>
	new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(iso))

const firstAmount = (payment: Payment): string => {
	const leg = payment.legs[0]
	return leg ? formatMoney(leg.amountIn.amount, leg.amountIn.currency) : "-"
}

const lastLeg = (payment: Payment): string => {
	const leg = payment.legs.at(-1)
	return leg ? leg.rail : "-"
}

const settleRelease = (payment: Payment): string | null => {
	const settle = payment.legs.find((leg) => leg.kind === "settle")
	return settle?.releaseTxRef ?? null
}

const shortSig = (sig: string): string =>
	sig.length < 16 ? sig : `${sig.slice(0, 6)}…${sig.slice(-6)}`

export function PaymentHistoryTable({ payments }: { payments: Payment[] }) {
	return (
		<div className="table-scroll">
			<table className="history-table" data-testid="payment-history">
				<thead>
					<tr>
						<th>Payment</th>
						<th>Created</th>
						<th>Delivery</th>
						<th>Route ends at</th>
						<th>Status</th>
						<th>Evidence</th>
						<th className="num">Amount</th>
					</tr>
				</thead>
				<tbody>
					{payments.map((payment) => {
						const release = settleRelease(payment)
						return (
							<tr key={payment.id}>
								<td>
									<Link to={`/payments/${encodeURIComponent(payment.id)}`}>
										<code className="code-text">{payment.id}</code>
									</Link>
								</td>
								<td>{when(payment.createdAt)}</td>
								<td>
									{payment.delivery === "claim_link" ? "Claim link" : "Direct"}
								</td>
								<td>{lastLeg(payment)}</td>
								<td>
									<StatusBadge status={payment.status} />
								</td>
								<td>
									{release ? (
										<code
											className="code-text"
											title={release}
											data-testid="payment-history-release"
										>
											{shortSig(release)}
										</code>
									) : (
										"—"
									)}
								</td>
								<td className="num">{firstAmount(payment)}</td>
							</tr>
						)
					})}
				</tbody>
			</table>
		</div>
	)
}
