/** CCR-32 bank endpoint detail keys accepted by POST /v1/endpoints. */
export type BankDetailKey =
	| "accountNumber"
	| "accountHolderName"
	| "bankName"
	| "swiftCode"
	| "iban"
	| "bankCode"
	| "branchCode"

export type BankDetailsForm = Record<BankDetailKey, string>

export const EMPTY_BANK_DETAILS: BankDetailsForm = {
	accountNumber: "",
	accountHolderName: "",
	bankName: "",
	swiftCode: "",
	iban: "",
	bankCode: "",
	branchCode: "",
}

const FIELD_LABELS: Readonly<Record<BankDetailKey, string>> = {
	accountNumber: "Account number",
	accountHolderName: "Account holder name",
	bankName: "Bank name",
	swiftCode: "SWIFT/BIC",
	iban: "IBAN",
	bankCode: "Bank code",
	branchCode: "Branch code",
}

const FIELD_ORDER: readonly BankDetailKey[] = [
	"accountNumber",
	"accountHolderName",
	"bankName",
	"swiftCode",
	"iban",
	"bankCode",
	"branchCode",
]

/** Human label for a CCR-32 bank detail key. */
export const bankDetailLabel = (key: BankDetailKey): string => FIELD_LABELS[key]

/**
 * Build the details object for POST /v1/endpoints.
 * Omits blank optional fields; accountNumber is required by the caller.
 */
export function bankDetailsPayload(
	form: BankDetailsForm,
): Record<string, string> {
	const details: Record<string, string> = {
		accountNumber: form.accountNumber.trim(),
	}
	for (const key of FIELD_ORDER) {
		if (key === "accountNumber") continue
		const value = form[key].trim()
		if (value) details[key] = value
	}
	return details
}

/**
 * Picker / list label for a saved (already masked) bank endpoint.
 * Example: "BDO ••3210" when bankName still has visible characters and the
 * account number ends in 3210.
 */
export function bankEndpointLabel(details: Record<string, string>): string {
	const account = details.accountNumber?.trim() ?? ""
	const last4 = account.slice(-4) || "????"
	const bankRaw = details.bankName?.trim() ?? ""
	const bankVisible = bankRaw.replace(/\*/g, "").trim()
	const bank =
		bankVisible || (bankRaw && !/^\*+$/.test(bankRaw) ? bankRaw : "") || "Bank"
	return `${bank} ••${last4}`
}

/**
 * Partner payout errors often name missing CCR-32 fields (e.g. swiftCode).
 * Turn those into "The bank needs: SWIFT/BIC" instead of the raw adapter text.
 */
export function friendlyPayoutLegError(message: string): string | null {
	const missing = FIELD_ORDER.filter((key) => {
		const re = new RegExp(`\\b${key}\\b`)
		return re.test(message)
	})
	if (missing.length === 0) return null
	return `The bank needs: ${missing.map((key) => FIELD_LABELS[key]).join(", ")}`
}
