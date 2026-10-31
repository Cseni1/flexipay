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
import { friendlyQuoteError } from "@flexipay/web-lib/quote-errors"
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { useNavigate } from "react-router-dom"
import {
	ApiError,
	createPayment,
	createQuote,
	createRecipient,
	describeApiError,
	isAuthRequired,
	listCorridors,
	listRecipients,
	type RecipientSummary,
} from "../api/client"
import {
	countriesFromCorridors,
	destinationsForCountry,
	regulationNoteFor,
	type CorridorSummary,
	type DestinationOption,
} from "../api/corridors"
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

type DestinationType = Extract<
	EndpointType,
	"bank_account" | "ewallet" | "crypto_wallet"
>

const RECIPIENT_KINDS: { value: RecipientKind; label: string }[] = [
	{ value: "individual", label: "Individual" },
	{ value: "company", label: "Company" },
]

const FEE_MODE_OPTIONS: { value: FeeMode; label: string }[] = FEE_MODES.map(
	(value) => ({
		value,
		label:
			value === "PayerPays"
				? "I pay the fee (added on top)"
				: "Recipient pays the fee (taken from what they receive)",
	}),
)

interface FormState {
	country: string
	destinationType: DestinationType | ""
	recipientKind: RecipientKind
	feeMode: FeeMode | ""
	amount: string
	recipientName: string
	existingRecipientId: string
}

const INITIAL_FORM: FormState = {
	country: "",
	destinationType: "",
	recipientKind: "individual",
	feeMode: "",
	amount: "",
	recipientName: "",
	existingRecipientId: "",
}

const toCorridorSummaries = (
	rows: Awaited<ReturnType<typeof listCorridors>>["corridors"],
): CorridorSummary[] =>
	rows.map((row) => ({
		fromCountry: row.from.country,
		fromCurrency: row.from.currency,
		toCountry: row.to.country,
		toCurrency: row.to.currency,
		allowedDestinationTypes: row.allowedDestinationTypes.filter(
			(type): type is EndpointType =>
				type === "bank_account" ||
				type === "ewallet" ||
				type === "crypto_wallet" ||
				type === "crypto_custodial",
		),
		recipientKinds: row.recipientKinds,
		regulationNote: row.regulationNote,
		simulated: row.simulated,
	}))

export default function SendPayment() {
	const navigate = useNavigate()
	const [form, setForm] = useState<FormState>(INITIAL_FORM)
	const [corridors, setCorridors] = useState<CorridorSummary[] | null>(null)
	const [corridorsError, setCorridorsError] = useState<string | null>(null)
	const [recipients, setRecipients] = useState<RecipientSummary[]>([])
	const [recipientsError, setRecipientsError] = useState<string | null>(null)
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

	useEffect(() => {
		const controller = new AbortController()
		let active = true

		listCorridors(controller.signal)
			.then((response) => {
				if (!active) return
				setCorridors(toCorridorSummaries(response.corridors))
				setCorridorsError(null)
			})
			.catch((cause: unknown) => {
				if (!active || controller.signal.aborted) return
				if (isAuthRequired(cause)) setAuthBlocked(true)
				setCorridors(null)
				setCorridorsError(
					cause instanceof ApiError
						? describeApiError(cause)
						: "Corridors could not be loaded from the API.",
				)
			})

		listRecipients(controller.signal)
			.then((response) => {
				if (!active) return
				setRecipients(response.recipients)
				setRecipientsError(null)
			})
			.catch((cause: unknown) => {
				if (!active || controller.signal.aborted) return
				if (isAuthRequired(cause)) setAuthBlocked(true)
				setRecipients([])
				setRecipientsError(
					cause instanceof ApiError
						? describeApiError(cause)
						: "Saved recipients could not be loaded.",
				)
			})

		return () => {
			active = false
			controller.abort()
		}
	}, [])

	useEffect(
		() => () => {
			quoteAbort.current?.abort()
			createAbort.current?.abort()
		},
		[],
	)

	const countryOptions = useMemo(() => {
		const fromApi = corridors ? countriesFromCorridors(corridors) : []
		return [{ value: "", label: "Select destination country" }, ...fromApi]
	}, [corridors])

	const destinationOptions: DestinationOption[] = useMemo(() => {
		if (!corridors || !form.country) return []
		return destinationsForCountry(corridors, form.country)
	}, [corridors, form.country])

	const corridorNote = useMemo(() => {
		if (!corridors || !form.country) return null
		return regulationNoteFor(corridors, form.country)
	}, [corridors, form.country])

	const update = (patch: Partial<FormState>) => {
		setForm((current) => ({ ...current, ...patch }))
		setQuote(null)
		setQuoteError(null)
		setFormError(null)
		setCreateError(null)
	}

	const changeCountry = (country: string) => {
		if (country === "") {
			update({ country, destinationType: "", existingRecipientId: "" })
			return
		}
		const options = corridors ? destinationsForCountry(corridors, country) : []
		update({
			country,
			destinationType: options[0]?.value ?? "",
			existingRecipientId: "",
		})
	}

	const applySavedRecipient = (recipientId: string) => {
		if (recipientId === "") {
			update({ existingRecipientId: "" })
			return
		}
		const saved = recipients.find((entry) => entry.id === recipientId)
		if (!saved) {
			update({ existingRecipientId: "" })
			return
		}
		const options = corridors
			? destinationsForCountry(corridors, saved.country)
			: []
		update({
			existingRecipientId: saved.id,
			recipientName: saved.name,
			recipientKind: saved.kind,
			country: saved.country,
			destinationType: options[0]?.value ?? "",
		})
	}

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
		if (!corridors) {
			setFormError("Corridors are not available from the API yet.")
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
			const saved =
				form.existingRecipientId &&
				recipients.find((entry) => entry.id === form.existingRecipientId)
			const recipientId =
				saved &&
				saved.name === form.recipientName.trim() &&
				saved.kind === form.recipientKind &&
				saved.country === form.country
					? saved.id
					: (
							await createRecipient(
								{
									name: form.recipientName.trim(),
									kind: form.recipientKind,
									country: form.country,
								},
								`recipient-${quote.id}`,
								controller.signal,
							)
						).id
			const payment = await createPayment(
				{
					quoteId: quote.id,
					recipientId,
					delivery,
					profile: "one_off",
				},
				`payment-${quote.id}`,
				controller.signal,
			)
			void navigate(`/payments/${encodeURIComponent(payment.id)}`, {
				// The claim token is returned only on create; GET /payments does not reissue it.
				state: payment.claimLink ? { claimLink: payment.claimLink } : null,
			})
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

	const corridorsUnavailable = corridors === null && corridorsError !== null

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

			{authBlocked ? (
				<Notice tone="warning">
					The local API proxy could not authenticate. Set the server-side
					FP_API_KEY for Vite, then restart the dev server.
				</Notice>
			) : null}

			{corridorsUnavailable ? (
				<Notice tone="warning" data-testid="corridors-unavailable">
					Corridors unavailable: {corridorsError}. Destination choices stay
					disabled until GET /v1/corridors responds.
				</Notice>
			) : null}

			{recipientsError ? (
				<Notice tone="warning" data-testid="recipients-unavailable">
					Saved recipients unavailable: {recipientsError}
				</Notice>
			) : null}

			<Grid>
				<Panel
					title="Payment details"
					description="The source is fixed for the MVP; countries and destinations come from GET /v1/corridors."
				>
					<form onSubmit={handleQuote}>
						<div className="form-grid">
							<StaticField
								label="Source"
								value="USD operating account"
								hint="US bank account · USD."
							/>
							<SelectField
								id="saved-recipient"
								label="Saved recipient"
								value={form.existingRecipientId}
								disabled={recipients.length === 0 || authBlocked}
								options={[
									{
										value: "",
										label:
											recipients.length === 0
												? "No saved recipients yet"
												: "Pay someone new",
									},
									...recipients.map((entry) => ({
										value: entry.id,
										label: `${entry.name} · ${entry.country}`,
									})),
								]}
								hint="Loaded from GET /v1/recipients. Choosing one reuses that recipient id."
								onChange={(event) => applySavedRecipient(event.target.value)}
							/>
							<SelectField
								id="destination-country"
								label="Destination country"
								value={form.country}
								disabled={!corridors || authBlocked}
								options={
									corridors
										? countryOptions
										: [{ value: "", label: "Waiting for corridors…" }]
								}
								onChange={(event) => changeCountry(event.target.value)}
							/>
							<SelectField
								id="destination-type"
								label="Destination"
								value={form.destinationType}
								disabled={!form.country || !corridors}
								options={
									destinationOptions.length > 0
										? destinationOptions.map(({ value, label }) => ({
												value,
												label,
											}))
										: [{ value: "", label: "Select a country first" }]
								}
								hint={corridorNote ?? undefined}
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
								label="Who pays the fee? (Vault fee payer)"
								value={form.feeMode}
								options={[
									{ value: "", label: "Choose who pays the fee" },
									...FEE_MODE_OPTIONS,
								]}
								hint="The 1% vault fee is either added to what you pay or taken from what the recipient gets. You must choose."
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
								hint="Paying someone new? Type their name here: they are added when you create the payment."
								autoComplete="off"
								value={form.recipientName}
								onChange={(event) =>
									update({
										recipientName: event.target.value,
										existingRecipientId: "",
									})
								}
							/>
						</div>

						{formError ? <Notice tone="warning">{formError}</Notice> : null}
						{quoteError ? (
							<>
								<Notice tone="warning" data-testid="quote-error">
									Quote request failed:{" "}
									{quoteError.reasons.length > 0
										? friendlyQuoteError(quoteError.reasons).message
										: describeApiError(quoteError)}
								</Notice>
								{quoteError.reasons.length > 0 ? (
									<details
										className="form-note"
										data-testid="quote-error-details"
									>
										<summary>Technical details</summary>
										<ul>
											{quoteError.reasons.map((reason) => (
												<li key={reason}>
													<code className="code-text">{reason}</code>
												</li>
											))}
										</ul>
									</details>
								) : null}
							</>
						) : null}

						<div className="form-actions">
							<Button
								type="submit"
								disabled={quotePending || authBlocked || corridorsUnavailable}
							>
								{quotePending
									? "Getting quote…"
									: authBlocked
										? "Authentication required"
										: corridorsUnavailable
											? "Corridors unavailable"
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
