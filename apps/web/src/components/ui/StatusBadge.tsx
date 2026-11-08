import {
	PAYMENT_STATUSES as DOMAIN_PAYMENT_STATUSES,
	type LegStatus,
	type PaymentStatus as DomainPaymentStatus,
} from "@flexipay/web-lib/contract"

/** CF0 also used these two labels for the shell and future batch screens. */
export type StatusValue = DomainPaymentStatus | LegStatus | "completed"

type StatusTone = "success" | "danger" | "warning" | "muted" | "neutral"

const LABELS: Record<StatusValue, string> = {
	pending: "Pending",
	quoted: "Quoted",
	awaiting_funding: "Waiting for payment",
	funded: "Paid in",
	processing: "On its way",
	paid: "Delivered",
	cancelled: "Cancelled",
	failed: "Failed",
	refunding: "Returning money",
	refunded: "Money returned",
	expired: "Expired",
	succeeded: "Succeeded",
	reversing: "Reversing",
	reversed: "Reversed",
	completed: "Completed",
}

const TONES: Record<StatusValue, StatusTone> = {
	pending: "neutral",
	quoted: "neutral",
	awaiting_funding: "warning",
	funded: "warning",
	processing: "warning",
	paid: "success",
	cancelled: "muted",
	failed: "danger",
	refunding: "warning",
	refunded: "muted",
	expired: "danger",
	succeeded: "success",
	reversing: "warning",
	reversed: "muted",
	completed: "success",
}

export const PAYMENT_STATUSES: StatusValue[] = [
	...DOMAIN_PAYMENT_STATUSES,
	"completed",
]

export interface StatusBadgeProps {
	status: StatusValue
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
