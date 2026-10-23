import { parseUsdInput } from "@flexipay/web-lib"
import {
	FEE_MODES,
	type CreateQuoteRequest,
	type Delivery,
	type EndpointType,
	type FeeMode,
	type Quote,
	type RecipientKind,
} from "@flexipay/web-lib/contract"
import { useEffect, useRef, useState, type FormEvent } from "react"
import { useNavigate } from "react-router-dom"
import {
	AUTH_NOT_CONFIGURED_MESSAGE,
	ApiError,
	createPayment,
	createQuote,
	createRecipient,
	describeApiError,
	isAuthRequired,
} from "../api/client"
import { QuotePanel } from "../components/payments/QuotePanel"
import {
	Button,
	Grid,
	InfoPopover,
	Notice,
	Page,
	PageHeader,
	Panel,
	SelectField,
	StaticField,
	TextField,
} from "../components/ui"
import { useCountdown } from "../hooks/useCountdown"

type Country = "US" | "PH" | "BR" | "ZA"
type DestinationType = Extract<
	EndpointType,
	"bank_account" | "ewallet" | "crypto_wallet"
>

interface DestinationOption {
	value: DestinationType
	label: string
	currency: string
}

const COUNTRIES: { value: Country | ""; label: string }[] = [
	{ value: "", label: "Select destination country" },
	{ value: "US", label: "United States" },
	{ value: "PH", label: "Philippines" },
	{ value: "BR", label: "Brazil" },
	{ value: "ZA", label: "South Africa" },
]

const DESTINATIONS: Record<Country, DestinationOption[]> = {
	US: [{ value: "bank_account", label: "Bank account", currency: "USD" }],
	PH: [
		{ value: "bank_account", label: "Bank account", currency: "PHP" },
		{ value: "ewallet", label: "E-wallet", currency: "PHP" },
		{ value: "crypto_wallet", label: "Crypto wallet", currency: "USDC" },
	],
	BR: [
		{ value: "bank_account", label: "Bank account", currency: "BRL" },
		{ value: "crypto_wallet", label: "Crypto wallet", currency: "USDC" },
	],
	ZA: [{ value: "bank_account", label: "Bank account", currency: "ZAR" }],
}

const RECIPIENT_KINDS: { value: RecipientKind; label: string }[] = [
	{ value: "individual", label: "Individual" },
	{ value: "company", label: "Company" },
]

const FEE_MODE_OPTIONS: { value: FeeMode; label: string }[] = FEE_MODES.map(
	(value) => ({
		value,
		label:
			value === "PayerPays"
				? "Payer pays the vault fee"
				: "Recipient pays the vault fee",
	}),
)

interface FormState {
	country: Country | ""
	destinationType: DestinationType | ""
	recipientKind: RecipientKind
	feeMode: FeeMode | ""
	amount: string
	recipientName: string
}

const INITIAL_FORM: FormState = {
	country: "",
	destinationType: "",
	recipientKind: "individual",
	feeMode: "",
	amount: "",
	recipientName: "",
}

export default function SendPayment() {
	const navigate = useNavigate()
	const [form, setForm] = useState<FormState>(INITIAL_FORM)
	const [quote, setQuote] = useState<Quote | null>(null)
	const [quotePending, setQuotePending] = useState(false)
	const [quoteError, setQuoteError] = useState<ApiError | null>(null)
	const [formError, setFormError] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)
	const [createError, setCreateError] = useState<string | null>(null)
	const [authBlocked, setAuthBlocked] = useState(false)
	const [delivery, setDelivery] = useState<Delivery>("direct")
	const quoteLock = useRef(false)
	const createLock = useRef(false)
	const quoteRequest = useRef(0)
	const quoteAbort = useRef<AbortController | null>(null)
	const createAbort = useRef<AbortController | null>(null)

	const countdown = useCountdown(quote?.validUntil ?? null)

	useEffect(
		() => () => {
			quoteAbort.current?.abort()
			createAbort.current?.abort()
		},
		[],
	)

	const update = (patch: Partial<FormState>) => {
		setForm((current) => ({ ...current, ...patch }))
		setQuote(null)
		setQuoteError(null)
		setFormError(null)
		setCreateError(null)
	}

	const changeCountry = (country: Country | "") => {
		if (country === "") {
			update({ country, destinationType: "" })
			return
		}
		update({
			country,
			destinationType: DESTINATIONS[country][0]?.value ?? "",
		})
	}

	const destinationOptions = form.country ? DESTINATIONS[form.country] : []
	const destination = destinationOptions.find(
		(option) => option.value === form.destinationType,
	)

	const handleQuote = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (quoteLock.current || authBlocked) return

		const amount = parseUsdInput(form.amount)
		if (amount === null || BigInt(amount) <= 0n) {
			setFormError("Enter a positive USD amount with at most two decimals.")
			return
		}
		if (!form.recipientName.trim()) {
			setFormError("Enter a recipient name.")
			return
		}
		if (!form.country) {
			setFormError("Choose a destination country.")
			return
		}
		if (!destination) {
			setFormError("Choose a destination type.")
			return
		}
		if (!form.feeMode) {
			setFormError("Choose who pays the vault fee.")
			return
		}

		quoteLock.current = true
		quoteAbort.current?.abort()
		const controller = new AbortController()
		quoteAbort.current = controller
		const requestId = ++quoteRequest.current
		setQuotePending(true)
		setQuoteError(null)
		setFormError(null)
		setCreateError(null)

		const request: CreateQuoteRequest = {
			source: { type: "bank_account", currency: "USD", country: "US" },
			destination: {
				type: destination.value,
				currency: destination.currency,
				country: form.country,
				recipientKind: form.recipientKind,
			},
			amount: { side: "send", value: { amount, currency: "USD" } },
			policy: "cheapest",
			feeMode: form.feeMode,
		}

		try {
			const next = await createQuote(request, controller.signal)
			if (requestId !== quoteRequest.current) return
			setQuote(next)
		} catch (cause) {
			if (controller.signal.aborted || requestId !== quoteRequest.current)
				return
			if (isAuthRequired(cause)) setAuthBlocked(true)
			setQuoteError(
				cause instanceof ApiError
					? cause
					: new ApiError(
							0,
							"unknown_error",
							"The quote could not be requested.",
						),
			)
		} finally {
			if (requestId === quoteRequest.current && !controller.signal.aborted) {
				setQuotePending(false)
				quoteLock.current = false
			}
		}
	}

	const handleCreate = async () => {
		if (!quote || countdown.expired || createLock.current || authBlocked) return
		createLock.current = true
		setCreating(true)
		setCreateError(null)
		const controller = new AbortController()
		createAbort.current = controller

		try {
			const recipient = await createRecipient(
				{
					name: form.recipientName.trim(),
					kind: form.recipientKind,
					country: form.country,
				},
				`recipient-${quote.id}`,
				controller.signal,
			)
			const payment = await createPayment(
				{
					quoteId: quote.id,
					recipientId: recipient.id,
					delivery,
					profile: "one_off",
				},
				`payment-${quote.id}`,
				controller.signal,
			)
			void navigate(`/payments/${encodeURIComponent(payment.id)}`)
		} catch (cause) {
			if (controller.signal.aborted) return
			if (isAuthRequired(cause)) setAuthBlocked(true)
			setCreateError(
				cause instanceof ApiError
					? `Payment creation failed: ${describeApiError(cause)}`
					: "Payment creation failed. Try again.",
			)
		} finally {
			if (!controller.signal.aborted) {
				setCreating(false)
				createLock.current = false
			}
		}
	}

	return (
		<Page>
			<PageHeader
				eyebrow="Payments"
				title="Send a payment"
				description="Build a payout from the quote contract, review the chosen route and create it. Funding and progress are on the payment detail screen."
				actions={
					<InfoPopover label="Route selection">
						The router first removes ineligible corridors, then chooses the
						first eligible provider. The quote lists the chosen route, its fees,
						the validity window and every exclusion reason it returned.
					</InfoPopover>
				}
			/>

			<Notice tone="warning">{AUTH_NOT_CONFIGURED_MESSAGE}</Notice>

			<Grid>
				<Panel
					title="Payment details"
					description="The source is fixed for the MVP; the quote is requested from the API."
				>
					<form onSubmit={handleQuote}>
						<div className="form-grid">
							<StaticField
								label="Source"
								value="USD operating account"
								hint="US bank account · USD."
							/>
							<SelectField
								id="destination-country"
								label="Destination country"
								value={form.country}
								options={COUNTRIES}
								onChange={(event) =>
									changeCountry(event.target.value as Country | "")
								}
							/>
							<SelectField
								id="destination-type"
								label="Destination"
								value={form.destinationType}
								disabled={!form.country}
								options={
									destinationOptions.length > 0
										? destinationOptions.map(({ value, label }) => ({
												value,
												label,
											}))
										: [{ value: "", label: "Select a country first" }]
								}
								onChange={(event) =>
									update({
										destinationType: event.target.value as DestinationType,
									})
								}
							/>
							<SelectField
								id="recipient-kind"
								label="Recipient kind"
								value={form.recipientKind}
								options={RECIPIENT_KINDS}
								onChange={(event) =>
									update({ recipientKind: event.target.value as RecipientKind })
								}
							/>
							<SelectField
								id="fee-mode"
								label="Vault fee payer"
								value={form.feeMode}
								options={[
									{ value: "", label: "Select who pays the vault fee" },
									...FEE_MODE_OPTIONS,
								]}
								hint="Required explicitly. Ignored only when the chosen route has no settle leg."
								onChange={(event) =>
									update({ feeMode: event.target.value as FeeMode | "" })
								}
							/>
							<TextField
								id="amount"
								label="Amount (USD)"
								placeholder="1250.00"
								inputMode="decimal"
								value={form.amount}
								hint="Major units with at most two decimals; the API receives integer minor units."
								onChange={(event) => update({ amount: event.target.value })}
							/>
							<TextField
								id="recipient"
								label="Recipient"
								placeholder="Worker A"
								autoComplete="off"
								value={form.recipientName}
								onChange={(event) =>
									update({ recipientName: event.target.value })
								}
							/>
						</div>

						{formError ? <Notice tone="warning">{formError}</Notice> : null}
						{quoteError ? (
							<Notice tone="warning">
								Quote request failed: {describeApiError(quoteError)}
							</Notice>
						) : null}

						<div className="form-actions">
							<Button type="submit" disabled={quotePending || authBlocked}>
								{quotePending
									? "Getting quote…"
									: authBlocked
										? "Authentication required"
										: "Get quote"}
							</Button>
							<span className="form-note">
								The quote is simulated and expires; no payment is created yet.
							</span>
						</div>
					</form>
				</Panel>

				<QuotePanel
					quote={quote}
					delivery={delivery}
					onDeliveryChange={setDelivery}
					onCreate={() => void handleCreate()}
					creating={creating}
					authBlocked={authBlocked}
					expired={countdown.expired}
					validityLabel={countdown.label}
					createError={createError}
				/>
			</Grid>
		</Page>
	)
}
