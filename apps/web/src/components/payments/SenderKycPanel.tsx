import { useState } from "react"
import {
	ApiError,
	describeApiError,
	saveBlindpayTos,
	submitBlindpayKyc,
} from "../../api/client"
import { Button, Notice, TextField } from "../ui"

type Step =
	| { step: "accept_terms"; url: string }
	| { step: "submit_kyc" }
	| { step: "wait_for_review"; kycStatus: string }
	| { step: "approved"; receiverId: string }

const isStep = (value: unknown): value is Step => {
	if (!value || typeof value !== "object" || !("step" in value)) return false
	const step = (value as { step?: unknown }).step
	return (
		step === "accept_terms" ||
		step === "submit_kyc" ||
		step === "wait_for_review" ||
		step === "approved"
	)
}

const empty = {
	email: "",
	first_name: "",
	last_name: "",
	date_of_birth: "",
	tax_id: "",
	address_line_1: "",
	city: "",
	state_province_region: "",
	postal_code: "",
	country: "US",
	id_doc_country: "US",
	id_doc_type: "PASSPORT",
	id_doc_front_file: "",
	selfie_file: "",
}

/**
 * CCR-45: the next BlindPay identity step. FlexiPay only forwards what the sender types.
 */
export function SenderKycPanel({ details }: { details: unknown }) {
	const [step, setStep] = useState<Step | null>(
		isStep(details) ? details : null,
	)
	const [tosId, setTosId] = useState("")
	const [fields, setFields] = useState(empty)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	if (!step) return null

	const saveTos = async () => {
		setBusy(true)
		setError(null)
		try {
			const next = await saveBlindpayTos(tosId.trim())
			if (isStep(next.next)) setStep(next.next)
		} catch (cause) {
			setError(
				cause instanceof ApiError
					? describeApiError(cause)
					: "Could not save the terms id",
			)
		} finally {
			setBusy(false)
		}
	}

	const submit = async () => {
		setBusy(true)
		setError(null)
		try {
			const next = await submitBlindpayKyc(fields)
			if (isStep(next.next)) setStep(next.next)
		} catch (cause) {
			setError(
				cause instanceof ApiError
					? describeApiError(cause)
					: "Could not submit identity details",
			)
		} finally {
			setBusy(false)
		}
	}

	return (
		<div data-testid="blindpay-kyc">
			{step.step === "accept_terms" ? (
				<>
					<Notice>
						Accept BlindPay&apos;s terms, then paste the tos id from the return
						address.
					</Notice>
					<p>
						<a
							href={step.url}
							target="_blank"
							rel="noreferrer"
							data-testid="blindpay-kyc-url"
						>
							Open BlindPay terms
						</a>
					</p>
					<TextField
						id="blindpay-tos-id"
						label="Terms id"
						value={tosId}
						onChange={(event) => setTosId(event.target.value)}
					/>
					<Button
						type="button"
						disabled={busy || tosId.trim().length === 0}
						onClick={() => void saveTos()}
					>
						Save terms id
					</Button>
				</>
			) : null}
			{step.step === "submit_kyc" ? (
				<div className="stack" data-testid="blindpay-kyc-form">
					<Notice>
						Send your own identity details to BlindPay. FlexiPay does not fill
						these in.
					</Notice>
					{(
						[
							["email", "Email"],
							["first_name", "First name"],
							["last_name", "Last name"],
							["date_of_birth", "Date of birth"],
							["tax_id", "Tax id"],
							["address_line_1", "Address"],
							["city", "City"],
							["state_province_region", "State"],
							["postal_code", "Postal code"],
							["country", "Country"],
							["id_doc_country", "ID country"],
							["id_doc_type", "ID type"],
							["id_doc_front_file", "ID document URL"],
							["selfie_file", "Selfie URL"],
						] as const
					).map(([key, label]) => (
						<TextField
							key={key}
							id={`blindpay-${key}`}
							label={label}
							value={fields[key]}
							onChange={(event) =>
								setFields((current) => ({
									...current,
									[key]: event.target.value,
								}))
							}
						/>
					))}
					<Button
						type="button"
						disabled={busy}
						onClick={() => void submit()}
						data-testid="blindpay-kyc-submit"
					>
						Submit identity
					</Button>
				</div>
			) : null}
			{step.step === "wait_for_review" ? (
				<Notice data-testid="blindpay-kyc-wait">
					BlindPay is reviewing your identity ({step.kycStatus}). You can quote
					after it is approved.
				</Notice>
			) : null}
			{step.step === "approved" ? (
				<Notice>Identity approved. Quote the payment again.</Notice>
			) : null}
			{error ? <Notice tone="warning">{error}</Notice> : null}
		</div>
	)
}
