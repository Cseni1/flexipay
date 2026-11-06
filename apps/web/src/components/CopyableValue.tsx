import { useState } from "react"
import { Button } from "./ui"

type Props = {
	value: string
	/** Accessible name for the copy control. */
	label?: string
	className?: string
	"data-testid"?: string
}

/**
 * Long id / signature / address: wraps on narrow screens with a copy control.
 */
export function CopyableValue({
	value,
	label = "Copy",
	className,
	"data-testid": testId,
}: Props) {
	const [copied, setCopied] = useState(false)

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(value)
			setCopied(true)
		} catch {
			setCopied(false)
		}
	}

	return (
		<span className={["copyable-value", className].filter(Boolean).join(" ")}>
			<code
				className="code-text copyable-value__text"
				title={value}
				data-testid={testId}
			>
				{value}
			</code>
			<span className="copyable-value__actions no-print">
				<Button
					type="button"
					variant="secondary"
					className="button--sm copyable-value__copy"
					onClick={() => void copy()}
					aria-label={label}
				>
					{copied ? "Copied" : "Copy"}
				</Button>
			</span>
		</span>
	)
}
