import { useState } from "react"
import { Button } from "../ui"

type Props = {
	signature: string
	explorerUrl: string
	/** Outer notice test id (panel vs detail page). */
	testId?: string
	/** Explorer anchor test id used by existing proofs. */
	explorerTestId?: string
}

export function SolanaTxSuccess({
	signature,
	explorerUrl,
	testId = "solana-pay-success",
	explorerTestId,
}: Props) {
	const [copied, setCopied] = useState(false)

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(signature)
			setCopied(true)
		} catch {
			setCopied(false)
		}
	}

	return (
		<div
			className="notice notice--info solana-success"
			role="note"
			data-testid={testId}
		>
			<p className="solana-success__title">Paid on Solana (devnet)</p>
			<p className="form-note">
				Transaction signature:{" "}
				<code className="code-text" data-testid="solana-tx-signature">
					{signature}
				</code>
			</p>
			<div className="form-actions solana-success__actions">
				<a
					className="button button--primary"
					href={explorerUrl}
					target="_blank"
					rel="noreferrer"
					data-testid={explorerTestId}
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
		</div>
	)
}
