import { type PaymentDetail } from "@flexipay/web-lib/contract"
import { useState } from "react"
import { findEventTime } from "../../payments/paymentEventTimes"
import { displayMoney } from "../../payments/quoteDisplay"
import { shortAddress } from "../../solana/walletStandard"
import { Button, StatusBadge } from "../ui"
import { PaymentTimestamp } from "./PaymentTimestamp"

type Props = {
	payment: PaymentDetail
	signature: string
	explorerUrl: string
	/** Optional on-chain recipient (Solana address); falls back to payment.recipientId. */
	receiverAddress?: string | null
}

/**
 * Print-friendly receipt for a paid payment. Keeps Solana success testids stable.
 */
export function PaymentReceipt({
	payment,
	signature,
	explorerUrl,
	receiverAddress,
}: Props) {
	const [copied, setCopied] = useState(false)
	const firstLeg = payment.legs[0]
	const settleLeg = payment.legs.find((leg) => leg.kind === "settle")
	const paidAt =
		findEventTime(payment.events, "payment.paid") ?? payment.updatedAt
	const amountLabel = firstLeg
		? displayMoney(firstLeg.amountIn.amount, firstLeg.amountIn.currency)
		: "—"
	const settleLabel =
		settleLeg && settleLeg.amountOut
			? displayMoney(settleLeg.amountOut.amount, settleLeg.amountOut.currency)
			: null
	const receiver = receiverAddress?.trim() || payment.recipientId
	const sender = payment.organizationId

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(signature)
			setCopied(true)
		} catch {
			setCopied(false)
		}
	}

	const print = () => window.print()

	return (
		<section
			className="payment-receipt"
			data-testid="payment-receipt"
			aria-label="Payment receipt"
		>
			<header className="payment-receipt__header">
				<div>
					<p className="eyebrow">Receipt</p>
					<h3 className="payment-receipt__title">Payment paid</h3>
					<p className="muted">
						Payment <code className="code-text">{payment.id}</code> ·{" "}
						<PaymentTimestamp
							iso={paidAt}
							data-testid="payment-receipt-paid-at"
						/>
					</p>
				</div>
				<StatusBadge status={payment.status} />
			</header>

			<dl className="payment-receipt__grid">
				<div>
					<dt>Amount</dt>
					<dd data-testid="payment-receipt-amount">{amountLabel}</dd>
				</div>
				{settleLabel ? (
					<div>
						<dt>Settled</dt>
						<dd>{settleLabel}</dd>
					</div>
				) : null}
				<div>
					<dt>Sender</dt>
					<dd data-testid="payment-receipt-sender">
						<code className="code-text" title={sender}>
							{shortAddress(sender)}
						</code>
					</dd>
				</div>
				<div>
					<dt>Receiver</dt>
					<dd data-testid="payment-receipt-receiver">
						<code className="code-text" title={receiver}>
							{shortAddress(receiver)}
						</code>
					</dd>
				</div>
				<div>
					<dt>Status</dt>
					<dd data-testid="payment-receipt-status">{payment.status}</dd>
				</div>
			</dl>

			<div
				className="notice notice--info solana-success"
				role="note"
				data-testid="solana-pay-success"
			>
				<p className="solana-success__title">Paid on Solana (devnet)</p>
				<p className="form-note">
					Transaction signature:{" "}
					<code className="code-text" data-testid="solana-tx-signature">
						{signature}
					</code>
				</p>
				<div className="form-actions solana-success__actions no-print">
					<a
						className="button button--primary"
						href={explorerUrl}
						target="_blank"
						rel="noreferrer"
						data-testid="payment-explorer-link"
					>
						View on Solana Explorer
					</a>
					<Button type="button" variant="secondary" onClick={() => void copy()}>
						Copy signature
					</Button>
					<span className="form-note" role="status">
						{copied ? "Copied" : ""}
					</span>
				</div>
				<p className="payment-receipt__print-only form-note">
					Explorer: {explorerUrl}
				</p>
			</div>

			<div className="form-actions no-print">
				<Button
					type="button"
					variant="secondary"
					onClick={print}
					data-testid="payment-receipt-print"
				>
					Print receipt
				</Button>
			</div>
		</section>
	)
}
