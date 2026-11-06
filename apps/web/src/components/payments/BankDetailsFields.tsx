import { useState } from "react"
import {
	bankDetailLabel,
	type BankDetailsForm,
} from "../../payments/bankDetails"
import { Button, TextField } from "../ui"

type Props = {
	value: BankDetailsForm
	onChange: (next: BankDetailsForm) => void
	disabled?: boolean
	/** Start with the IBAN / bank code / branch code row open. */
	defaultMoreOpen?: boolean
	"data-testid"?: string
}

/**
 * CCR-32 bank details: account number required; holder, bank, SWIFT always
 * visible; IBAN / bank code / branch code behind More.
 */
export function BankDetailsFields({
	value,
	onChange,
	disabled = false,
	defaultMoreOpen = false,
	"data-testid": testId = "bank-details",
}: Props) {
	const [moreOpen, setMoreOpen] = useState(defaultMoreOpen)

	const patch = (key: keyof BankDetailsForm, next: string) => {
		onChange({ ...value, [key]: next })
	}

	return (
		<fieldset className="bank-details" data-testid={testId} disabled={disabled}>
			<legend className="bank-details__legend">Bank details</legend>
			<div className="form-grid">
				<TextField
					id={`${testId}-account-number`}
					label={`${bankDetailLabel("accountNumber")} (required)`}
					value={value.accountNumber}
					autoComplete="off"
					aria-required="true"
					onChange={(event) => patch("accountNumber", event.target.value)}
				/>
				<TextField
					id={`${testId}-account-holder`}
					label={bankDetailLabel("accountHolderName")}
					value={value.accountHolderName}
					autoComplete="off"
					onChange={(event) => patch("accountHolderName", event.target.value)}
				/>
				<TextField
					id={`${testId}-bank-name`}
					label={bankDetailLabel("bankName")}
					value={value.bankName}
					autoComplete="off"
					onChange={(event) => patch("bankName", event.target.value)}
				/>
				<TextField
					id={`${testId}-swift`}
					label={bankDetailLabel("swiftCode")}
					value={value.swiftCode}
					autoComplete="off"
					onChange={(event) => patch("swiftCode", event.target.value)}
				/>
			</div>
			<div className="bank-details__more">
				<Button
					type="button"
					variant="ghost"
					data-testid={`${testId}-more`}
					aria-expanded={moreOpen}
					onClick={() => setMoreOpen((open) => !open)}
				>
					{moreOpen ? "Hide extra fields" : "More"}
				</Button>
				{moreOpen ? (
					<div className="form-grid" data-testid={`${testId}-extra`}>
						<TextField
							id={`${testId}-iban`}
							label={bankDetailLabel("iban")}
							value={value.iban}
							autoComplete="off"
							onChange={(event) => patch("iban", event.target.value)}
						/>
						<TextField
							id={`${testId}-bank-code`}
							label={bankDetailLabel("bankCode")}
							value={value.bankCode}
							autoComplete="off"
							onChange={(event) => patch("bankCode", event.target.value)}
						/>
						<TextField
							id={`${testId}-branch-code`}
							label={bankDetailLabel("branchCode")}
							value={value.branchCode}
							autoComplete="off"
							onChange={(event) => patch("branchCode", event.target.value)}
						/>
					</div>
				) : null}
			</div>
		</fieldset>
	)
}
