import {
	formatLocalDateTime,
	formatUtcTitle,
} from "../../payments/formatPaymentTime"

type Props = {
	iso: string | null | undefined
	/** Shown when iso is missing. Default "-". */
	fallback?: string
	className?: string
	"data-testid"?: string
}

/** Local date+time with UTC in the title attribute. */
export function PaymentTimestamp({
	iso,
	fallback = "-",
	className,
	"data-testid": testId,
}: Props) {
	if (!iso) {
		return (
			<span className={className} data-testid={testId}>
				{fallback}
			</span>
		)
	}
	return (
		<time
			className={className}
			dateTime={iso}
			title={formatUtcTitle(iso)}
			data-testid={testId}
		>
			{formatLocalDateTime(iso)}
		</time>
	)
}
