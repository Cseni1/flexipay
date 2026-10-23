export type PaymentStatus =
	| "pending"
	| "paid"
	| "completed"
	| "failed"
	| "expired"
	| "processing"
	| "awaiting_funding"
	| "refunded"
	| "cancelled"

type StatusTone = "success" | "danger" | "warning" | "muted" | "neutral"

const LABELS: Record<PaymentStatus, string> = {
	pending: "Pending",
	paid: "Paid",
	completed: "Completed",
	failed: "Failed",
	expired: "Expired",
	processing: "Processing",
	awaiting_funding: "Awaiting funding",
	refunded: "Refunded",
	cancelled: "Cancelled",
}

const TONES: Record<PaymentStatus, StatusTone> = {
	pending: "neutral",
	paid: "success",
	completed: "success",
	failed: "danger",
	expired: "danger",
	processing: "warning",
	awaiting_funding: "warning",
	refunded: "muted",
	cancelled: "muted",
}

export const PAYMENT_STATUSES = Object.keys(LABELS) as PaymentStatus[]

export interface StatusBadgeProps {
	status: PaymentStatus
	label?: string
}

export function StatusBadge({ status, label }: StatusBadgeProps) {
	return (
		<span
			className={`status-badge status-badge--${TONES[status]}`}
			data-status={status}
		>
			<span className="status-badge__dot" aria-hidden="true" />
			{label ?? LABELS[status]}
		</span>
	)
}
