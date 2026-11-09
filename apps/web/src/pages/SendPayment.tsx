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
	createEndpoint,
	createPayment,
	createQuote,
	createRecipient,
	describeApiError,
	getPayoutRequirements,
	isAuthRequired,
	listCorridors,
	listEndpoints,
	listRecipients,
	type EndpointSummary,
	type PayoutRequirements,
	type RecipientAddressInput,
	type RecipientSummary,
} from "../api/client"
import {
	countriesFromCorridors,
	countryLabel,
	defaultSourceForCountry,
	destinationsForCountry,
	regulationNoteFor,
	allSources,
	sendFromLabel,
	sourceFromKey,
	sourceKey,
	sourceStaticLabel,
	sourcesForCountry,
	summarizeCorridor,
	type CorridorSummary,
	type DestinationOption,
	type SourceEndpoint,
} from "../api/corridors"
import { AuthBlockedNotice } from "../components/AuthBlockedNotice"
import { BankDetailsFields } from "../components/payments/BankDetailsFields"
import { QuotePanel } from "../components/payments/QuotePanel"
import { SenderKycPanel } from "../components/payments/SenderKycPanel"
import {
	Button,
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
import {
	EMPTY_BANK_DETAILS,
	bankDetailLabel,
	bankDetailsPayload,
	bankEndpointLabel,
	type BankDetailKey,
	type BankDetailsForm,
} from "../payments/bankDetails"
import {
	linkPaymentSaving,
	rememberSavingFromQuote,
} from "../payments/quoteSavingStore"
import { assetLabel } from "../solana/assets"

/** Sentinel for "enter a new bank account" in the saved-endpoint picker. */
const NEW_BANK_ENDPOINT = "__new__"

type DestinationType = Extract<
	EndpointType,
	"bank_account" | "ewallet" | "crypto_wallet"
>

type FallbackCountry = "US" | "PH" | "BR" | "ZA" | "GB"

/** Static MVP choices used when GET /v1/corridors is unavailable (fixture / offline UX). */
const FALLBACK_COUNTRIES: { value: FallbackCountry | ""; label: string }[] = [
	{ value: "", label: "Select destination country" },
	{ value: "US", label: "United States" },
	{ value: "PH", label: "Philippines" },
	{ value: "BR", label: "Brazil" },
	{ value: "ZA", label: "South Africa" },
	{ value: "GB", label: "United Kingdom" },
]

const FALLBACK_DESTINATIONS: Record<FallbackCountry, DestinationOption[]> = {
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
	GB: [
		{
			value: "crypto_wallet",
			label: `Crypto wallet (${assetLabel("TGBP")})`,
			currency: "TGBP",
		},
	],
}

const FALLBACK_SOURCES: Record<FallbackCountry, SourceEndpoint> = {
	US: { type: "bank_account", currency: "USD", country: "US" },
	PH: { type: "bank_account", currency: "USD", country: "US" },
	BR: { type: "bank_account", currency: "USD", country: "US" },
	ZA: { type: "bank_account", currency: "USD", country: "US" },
	GB: { type: "bank_account", currency: "GBP", country: "GB" },
}

// Pounds are FlexiPay's main focus: before a country is picked, the form sends from GBP.
const DEFAULT_SOURCE: SourceEndpoint = {
	type: "bank_account",
	currency: "GBP",
	country: "GB",
}

const isFallbackCountry = (country: string): country is FallbackCountry =>
	Object.prototype.hasOwnProperty.call(FALLBACK_DESTINATIONS, country)

const sourceForForm = (
	corridors: CorridorSummary[] | null,
	country: string,
	selectedKey: string,
): SourceEndpoint => {
	// No country yet: honour the sender's Send from choice (it shows before the country).
	if (!country) {
		const chosen = sourceFromKey(selectedKey)
		if (chosen) return chosen
	}
	if (corridors && country) {
		const selected = sourceFromKey(selectedKey)
		if (
			selected &&
			sourcesForCountry(corridors, country).some(
				(entry) => sourceKey(entry) === selectedKey,
			)
		) {
			return selected
		}
		const fromApi = defaultSourceForCountry(corridors, country)
		if (fromApi) return fromApi
	}
	if (isFallbackCountry(country)) return FALLBACK_SOURCES[country]
	return DEFAULT_SOURCE
}

const amountFieldCopy = (
	sourceCurrency: string,
): { label: string; placeholder: string; hint: string } => {
	if (sourceCurrency === "GBP") {
		return {
			label: "Amount (£)",
			placeholder: "10.00",
			hint: "For example 25 or 25.50.",
		}
	}
	return {
		label: "Amount (USD)",
		placeholder: "1250.00",
		hint: "For example 25 or 25.50.",
	}
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
				? "I pay the fee (added on top)"
				: "Recipient pays the fee (taken from what they receive)",
	}),
)

interface FormState {
	country: string
	sourceKey: string
	destinationType: DestinationType | ""
	recipientKind: RecipientKind
	feeMode: FeeMode | ""
	amount: string
	recipientName: string
	existingRecipientId: string
}

interface AddressForm {
	line1: string
	line2: string
	city: string
	state: string
	postalCode: string
}

const EMPTY_ADDRESS: AddressForm = {
	line1: "",
	line2: "",
	city: "",
	state: "",
	postalCode: "",
}

const KNOWN_BANK_KEYS = new Set<BankDetailKey>([
	"accountNumber",
	"accountHolderName",
	"bankName",
	"swiftCode",
	"iban",
	"bankCode",
	"branchCode",
])

function addressPayload(
	form: AddressForm,
	country: string,
): RecipientAddressInput | undefined {
	const line1 = form.line1.trim()
	const city = form.city.trim()
	const state = form.state.trim()
	const postalCode = form.postalCode.trim()
	if (!line1 || !city || !state || !postalCode) return undefined
	const line2 = form.line2.trim()
	return {
		line1,
		...(line2 ? { line2 } : {}),
		city,
		state,
		postalCode,
		country,
	}
}

const INITIAL_FORM: FormState = {
	country: "",
	sourceKey: "",
	destinationType: "",
	recipientKind: "individual",
	feeMode: "",
	amount: "",
	recipientName: "",
	existingRecipientId: "",
}

const destinationsForForm = (
	corridors: CorridorSummary[] | null,
	country: string,
	source: SourceEndpoint | null,
): DestinationOption[] => {
	if (!country) return []
	if (corridors) {
		return destinationsForCountry(corridors, country, source ?? undefined)
	}
	if (isFallbackCountry(country)) return FALLBACK_DESTINATIONS[country]
	return []
}

const resolveSourceKey = (
	corridors: CorridorSummary[] | null,
	country: string,
): string => {
	if (!country) return ""
	if (corridors) {
		const preferred = defaultSourceForCountry(corridors, country)
		return preferred ? sourceKey(preferred) : ""
	}
	if (isFallbackCountry(country)) return sourceKey(FALLBACK_SOURCES[country])
	return sourceKey(DEFAULT_SOURCE)
}

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
	const [senderWallet, setSenderWallet] = useState(false)
	const [recipientCountryNote, setRecipientCountryNote] = useState<
		string | null
	>(null)
	const [bankDetails, setBankDetails] =
		useState<BankDetailsForm>(EMPTY_BANK_DETAILS)
	const [address, setAddress] = useState<AddressForm>(EMPTY_ADDRESS)
	const [payoutRequirements, setPayoutRequirements] =
		useState<PayoutRequirements | null>(null)
	const [bankEndpointChoice, setBankEndpointChoice] =
		useState(NEW_BANK_ENDPOINT)
	const [recipientBankEndpoints, setRecipientBankEndpoints] = useState<
		EndpointSummary[]
	>([])
	const [bankEndpointsError, setBankEndpointsError] = useState<string | null>(
		null,
	)
	const quoteLock = useRef(false)
	const createLock = useRef(false)
	const quoteRequest = useRef(0)
	const quoteAbort = useRef<AbortController | null>(null)
	const createAbort = useRef<AbortController | null>(null)
	const bankEndpointsAbort = useRef<AbortController | null>(null)

	const countdown = useCountdown(quote?.validUntil ?? null)

	useEffect(() => {
		const controller = new AbortController()
		let active = true

		listCorridors(controller.signal)
			.then((response) => {
				if (!active) return
				setCorridors(response.corridors.map(summarizeCorridor))
				setCorridorsError(null)
			})
			.catch((cause: unknown) => {
				if (!active || controller.signal.aborted) return
				// Do not flip authBlocked here: CF5 and quote UX need the form usable so a
				// later quote call can surface the proxy / FP_API_KEY configuration error.
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
			bankEndpointsAbort.current?.abort()
		},
		[],
	)

	const countryOptions = useMemo(() => {
		if (!corridors) return FALLBACK_COUNTRIES
		const fromApi = countriesFromCorridors(corridors)
		return [{ value: "", label: "Select destination country" }, ...fromApi]
	}, [corridors])

	const source = useMemo(
		() => sourceForForm(corridors, form.country, form.sourceKey),
		[corridors, form.country, form.sourceKey],
	)

	const sendFromOptions = useMemo(() => {
		if (!corridors) return []
		// Before a country is chosen, offer every source (pounds first) so the sender picks first.
		if (!form.country) return allSources(corridors)
		return sourcesForCountry(corridors, form.country)
	}, [corridors, form.country])

	const showSendFrom = sendFromOptions.length > 1

	const destinationOptions: DestinationOption[] = useMemo(
		() => destinationsForForm(corridors, form.country, source),
		[corridors, form.country, source],
	)

	const corridorNote = useMemo(() => {
		if (!corridors || !form.country) return null
		return regulationNoteFor(corridors, form.country, source)
	}, [corridors, form.country, source])

	const amountCopy = amountFieldCopy(source.currency)

	// TASK 20 fix: a country picked before GET /v1/corridors answers (fallback list, cold API)
	// got the fallback source. Re-resolve the default once corridors arrive, unless the user
	// chose "Send from" themselves.
	const sendFromChosen = useRef(false)
	useEffect(() => {
		if (!corridors || sendFromChosen.current) return
		setForm((current) => {
			if (!current.country) return current
			const key = resolveSourceKey(corridors, current.country)
			if (!key || key === current.sourceKey) return current
			const source = sourceForForm(corridors, current.country, key)
			const options = destinationsForForm(corridors, current.country, source)
			const keepType = options.some((o) => o.value === current.destinationType)
			return {
				...current,
				sourceKey: key,
				destinationType: keepType
					? current.destinationType
					: (options[0]?.value ?? ""),
			}
		})
	}, [corridors])

	// One entry per person and country (the newest), named in full: "Maria Santos · Philippines".
	const savedRecipientOptions = useMemo(() => {
		const seen = new Set<string>()
		const options: { value: string; label: string }[] = []
		for (const entry of recipients) {
			const key = `${entry.name.trim().toLowerCase()}|${entry.country}`
			if (seen.has(key)) continue
			seen.add(key)
			options.push({
				value: entry.id,
				label: `${entry.name} · ${countryLabel(entry.country)}`,
			})
		}
		return options
	}, [recipients])

	// A claim link lets the recipient choose their bank later, so no bank details are asked for.
	const showBankDetails =
		form.destinationType === "bank_account" && delivery === "direct"

	const matchingBankEndpoints = useMemo(() => {
		if (form.destinationType !== "bank_account") return []
		const dest = destinationOptions.find(
			(option) => option.value === form.destinationType,
		)
		if (!dest) return []
		return recipientBankEndpoints.filter(
			(endpoint) =>
				endpoint.type === "bank_account" &&
				endpoint.country === form.country &&
				endpoint.currency === dest.currency,
		)
	}, [
		destinationOptions,
		form.country,
		form.destinationType,
		recipientBankEndpoints,
	])

	useEffect(() => {
		if (form.destinationType !== "bank_account" || !form.existingRecipientId) {
			bankEndpointsAbort.current?.abort()
			setRecipientBankEndpoints([])
			setBankEndpointsError(null)
			setBankEndpointChoice(NEW_BANK_ENDPOINT)
			return
		}
		bankEndpointsAbort.current?.abort()
		const controller = new AbortController()
		bankEndpointsAbort.current = controller
		setBankEndpointsError(null)
		void listEndpoints({
			recipientId: form.existingRecipientId,
			signal: controller.signal,
		})
			.then((response) => {
				if (controller.signal.aborted) return
				const banks = response.endpoints.filter(
					(endpoint) => endpoint.type === "bank_account",
				)
				setRecipientBankEndpoints(banks)
				setBankEndpointChoice((current) => {
					if (
						current !== NEW_BANK_ENDPOINT &&
						banks.some((entry) => entry.id === current)
					) {
						return current
					}
					return banks[0]?.id ?? NEW_BANK_ENDPOINT
				})
			})
			.catch((cause: unknown) => {
				if (controller.signal.aborted) return
				setRecipientBankEndpoints([])
				setBankEndpointChoice(NEW_BANK_ENDPOINT)
				setBankEndpointsError(
					cause instanceof ApiError
						? describeApiError(cause)
						: "Saved bank accounts could not be loaded.",
				)
			})
		return () => {
			controller.abort()
		}
	}, [form.destinationType, form.existingRecipientId])

	const update = (patch: Partial<FormState>) => {
		setForm((current) => ({ ...current, ...patch }))
		setQuote(null)
		setQuoteError(null)
		setFormError(null)
		setCreateError(null)
	}

	const changeCountry = (country: string) => {
		// Keep a Send from the sender picked before the country, if that country can be paid from it.
		const keepKey =
			sendFromChosen.current &&
			corridors !== null &&
			country !== "" &&
			sourcesForCountry(corridors, country).some(
				(entry) => sourceKey(entry) === form.sourceKey,
			)
				? form.sourceKey
				: null
		sendFromChosen.current = keepKey !== null
		setRecipientCountryNote(null)
		setBankDetails(EMPTY_BANK_DETAILS)
		setAddress(EMPTY_ADDRESS)
		if (country === "") {
			update({
				country,
				sourceKey: "",
				destinationType: "",
				existingRecipientId: "",
			})
			return
		}
		const nextSourceKey = keepKey ?? resolveSourceKey(corridors, country)
		const nextSource = sourceForForm(corridors, country, nextSourceKey)
		const options = destinationsForForm(corridors, country, nextSource)
		update({
			country,
			sourceKey: nextSourceKey,
			destinationType: options[0]?.value ?? "",
			existingRecipientId: "",
		})
	}

	const changeSendFrom = (nextKey: string) => {
		sendFromChosen.current = true
		const nextSource = sourceForForm(corridors, form.country, nextKey)
		const options = destinationsForForm(corridors, form.country, nextSource)
		update({
			sourceKey: nextKey,
			destinationType: options[0]?.value ?? "",
		})
	}

	const applySavedRecipient = (recipientId: string) => {
		if (recipientId === "") {
			setRecipientCountryNote(null)
			setBankDetails(EMPTY_BANK_DETAILS)
			setAddress(EMPTY_ADDRESS)
			update({ existingRecipientId: "" })
			return
		}
		const saved = recipients.find((entry) => entry.id === recipientId)
		if (!saved) {
			setRecipientCountryNote(null)
			update({ existingRecipientId: "" })
			return
		}
		const previousCountry = form.country
		const nextSourceKey = resolveSourceKey(corridors, saved.country)
		const nextSource = sourceForForm(corridors, saved.country, nextSourceKey)
		const options = destinationsForForm(corridors, saved.country, nextSource)
		setBankDetails(EMPTY_BANK_DETAILS)
		setAddress(
			saved.address
				? {
						line1: saved.address.line1,
						line2: saved.address.line2 ?? "",
						city: saved.address.city,
						state: saved.address.state,
						postalCode: saved.address.postalCode,
					}
				: EMPTY_ADDRESS,
		)
		update({
			existingRecipientId: saved.id,
			recipientName: saved.name,
			recipientKind: saved.kind,
			country: saved.country,
			sourceKey: nextSourceKey,
			destinationType: options[0]?.value ?? "",
		})
		setRecipientCountryNote(
			previousCountry !== "" && previousCountry !== saved.country
				? `Country changed to ${countryLabel(saved.country)} to match this recipient`
				: null,
		)
	}

	const destination = destinationOptions.find(
		(option) => option.value === form.destinationType,
	)

	const requiredBankKeys = useMemo(
		() =>
			(payoutRequirements?.detailKeys ?? []).filter(
				(key): key is BankDetailKey =>
					KNOWN_BANK_KEYS.has(key as BankDetailKey),
			),
		[payoutRequirements],
	)
	const addressRequired = payoutRequirements?.addressRequired === true

	useEffect(() => {
		if (!showBankDetails || !form.country || !destination?.currency) {
			setPayoutRequirements(null)
			return
		}
		const controller = new AbortController()
		getPayoutRequirements(form.country, destination.currency, controller.signal)
			.then((requirements) => {
				if (!controller.signal.aborted) setPayoutRequirements(requirements)
			})
			.catch(() => {
				if (!controller.signal.aborted) setPayoutRequirements(null)
			})
		return () => controller.abort()
	}, [showBankDetails, form.country, destination?.currency])

	const usingSavedRecipient = Boolean(form.existingRecipientId)
	const showBankPicker = showBankDetails && usingSavedRecipient
	const enteringNewBank =
		showBankDetails &&
		(!usingSavedRecipient ||
			bankEndpointChoice === NEW_BANK_ENDPOINT ||
			matchingBankEndpoints.length === 0)

	const handleQuote = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (quoteLock.current || authBlocked) return

		const amount = parseUsdInput(form.amount)
		if (amount === null || BigInt(amount) <= 0n) {
			setFormError(
				source.currency === "GBP"
					? "Enter a positive £ amount with at most two decimals."
					: "Enter a positive USD amount with at most two decimals.",
			)
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
		if (!senderWallet && !form.feeMode) {
			setFormError("Choose who pays the vault fee.")
			return
		}
		const postedAddress = addressPayload(address, form.country)
		if (addressRequired && delivery === "direct" && !postedAddress) {
			setFormError(
				"Enter the recipient's address: line 1, city, state and postal code.",
			)
			return
		}
		const missingBank = requiredBankKeys.filter(
			(key) => key !== "accountNumber" && !bankDetails[key].trim(),
		)
		if (showBankDetails && enteringNewBank && missingBank.length > 0) {
			setFormError(
				`This country needs: ${missingBank
					.map((key) => bankDetailLabel(key))
					.join(", ")}.`,
			)
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

		const filledDetails = showBankDetails
			? bankDetailsPayload(bankDetails)
			: undefined
		if (filledDetails && !filledDetails.accountNumber) {
			delete filledDetails.accountNumber
		}
		const payout =
			(filledDetails && Object.keys(filledDetails).length > 0) || postedAddress
				? {
						...(filledDetails && Object.keys(filledDetails).length > 0
							? { details: filledDetails }
							: {}),
						...(postedAddress ? { address: postedAddress } : {}),
					}
				: undefined

		const request: CreateQuoteRequest = {
			source,
			destination: {
				type: destination.value,
				currency: destination.currency,
				country: form.country,
				recipientKind: form.recipientKind,
			},
			amount: {
				side: "send",
				value: { amount, currency: source.currency },
			},
			policy: "cheapest",
			...(senderWallet
				? { settleMode: "sender_wallet_blindpay" as const }
				: { feeMode: form.feeMode as FeeMode }),
			...(payout ? { payout } : {}),
		}

		try {
			const next = await createQuote(request, controller.signal)
			if (requestId !== quoteRequest.current) return
			rememberSavingFromQuote(next)
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
		if (
			showBankDetails &&
			enteringNewBank &&
			!bankDetails.accountNumber.trim()
		) {
			setCreateError("Enter the recipient's account number.")
			return
		}
		createLock.current = true
		setCreating(true)
		setCreateError(null)
		const controller = new AbortController()
		createAbort.current = controller

		try {
			const saved = form.existingRecipientId
				? recipients.find((entry) => entry.id === form.existingRecipientId)
				: undefined
			const createdAddress = addressPayload(address, form.country)
			const savedAddressMatches =
				!createdAddress ||
				(saved?.address?.line1 === createdAddress.line1 &&
					saved?.address?.city === createdAddress.city &&
					saved?.address?.state === createdAddress.state &&
					saved?.address?.postalCode === createdAddress.postalCode &&
					(saved?.address?.line2 ?? "") === (createdAddress.line2 ?? ""))
			const recipientId =
				saved &&
				saved.name === form.recipientName.trim() &&
				saved.kind === form.recipientKind &&
				saved.country === form.country &&
				savedAddressMatches
					? saved.id
					: (
							await createRecipient(
								{
									name: form.recipientName.trim(),
									kind: form.recipientKind,
									country: form.country,
									...(createdAddress ? { address: createdAddress } : {}),
								},
								`recipient-${quote.id}`,
								controller.signal,
							)
						).id

			let endpointId: string | undefined
			if (showBankDetails && destination) {
				if (
					!enteringNewBank &&
					bankEndpointChoice &&
					bankEndpointChoice !== NEW_BANK_ENDPOINT
				) {
					endpointId = bankEndpointChoice
				} else {
					const createdEndpoint = await createEndpoint(
						{
							recipientId,
							type: "bank_account",
							country: form.country,
							currency: destination.currency,
							network: null,
							details: bankDetailsPayload(bankDetails),
							simulated: true,
						},
						`endpoint-${quote.id}`,
						controller.signal,
					)
					endpointId = createdEndpoint.id
				}
			}

			const payment = await createPayment(
				{
					quoteId: quote.id,
					recipientId,
					delivery: senderWallet ? "direct" : delivery,
					profile: "one_off",
					...(endpointId ? { endpointId } : {}),
				},
				`payment-${quote.id}`,
				controller.signal,
			)
			rememberSavingFromQuote(quote)
			linkPaymentSaving(payment.id, quote.id)
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
				eyebrow="Send money"
				title="Send a payment"
				description="Three steps: who, where, how much. You see the exact price before anything is paid."
				actions={
					<InfoPopover label="Route selection">
						The router first removes ineligible corridors, then chooses the
						first eligible provider. The quote lists the chosen route, its fees,
						the validity window and every exclusion reason it returned.
					</InfoPopover>
				}
			/>

			{authBlocked ? <AuthBlockedNotice /> : null}

			{corridorsUnavailable ? (
				<Notice tone="warning" data-testid="corridors-unavailable">
					We could not load the latest country list ({corridorsError}), so we
					are showing our built-in list.
				</Notice>
			) : null}

			{recipientsError ? (
				<Notice tone="warning" data-testid="recipients-unavailable">
					We could not load your saved people: {recipientsError}
				</Notice>
			) : null}

			<div className="send-layout">
				<Panel
					title="New payment"
					description="Fill in the three steps, then tap Get quote to see the price."
				>
					<form onSubmit={handleQuote}>
						<div className="send-steps">
							<fieldset className="send-step">
								<legend className="send-step__title">
									<span className="send-step__num">1</span>
									Who are you paying?
								</legend>
								<div className="form-grid">
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
											...savedRecipientOptions,
										]}
										hint="Paid them before? Pick them here."
										onChange={(event) =>
											applySavedRecipient(event.target.value)
										}
									/>
									<TextField
										id="recipient"
										label="Recipient"
										placeholder="Their full name"
										hint="New person? Type their name."
										autoComplete="off"
										value={form.recipientName}
										onChange={(event) => {
											setRecipientCountryNote(null)
											update({
												recipientName: event.target.value,
												existingRecipientId: "",
											})
										}}
									/>
									{recipientCountryNote ? (
										<p
											className="form-note"
											data-testid="recipient-country-note"
										>
											{recipientCountryNote}
										</p>
									) : null}
									<SelectField
										id="recipient-kind"
										label="Recipient kind"
										value={form.recipientKind}
										options={RECIPIENT_KINDS}
										onChange={(event) =>
											update({
												recipientKind: event.target.value as RecipientKind,
											})
										}
									/>
								</div>
								<fieldset
									className="option-list send-delivery"
									data-testid="send-delivery"
								>
									<legend className="field__label">
										Who types in their account details?
									</legend>
									<label className="option-card">
										<input
											type="radio"
											name="delivery"
											value="direct"
											checked={delivery === "direct"}
											onChange={() => setDelivery("direct")}
										/>
										<span className="option-card__body">
											<span className="option-card__title">
												I’ll type in their account details
											</span>
											<span className="option-card__detail">
												Their bank, e-wallet or wallet details go in step 2.
											</span>
										</span>
									</label>
									<label
										className="option-card"
										data-testid="delivery-claim-link"
									>
										<input
											type="radio"
											name="delivery"
											value="claim_link"
											checked={delivery === "claim_link"}
											onChange={() => setDelivery("claim_link")}
										/>
										<span className="option-card__body">
											<span className="option-card__title">
												Send them a claim link
											</span>
											<span className="option-card__detail">
												They type in their own account details. You don’t need
												them.
											</span>
										</span>
									</label>
								</fieldset>
							</fieldset>
							<fieldset className="send-step">
								<legend className="send-step__title">
									<span className="send-step__num">2</span>
									Where does the money go?
								</legend>
								<div className="form-grid">
									<SelectField
										id="destination-country"
										label="Destination country"
										value={form.country}
										disabled={authBlocked}
										options={countryOptions}
										onChange={(event) => changeCountry(event.target.value)}
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
										hint={corridorNote ?? undefined}
										onChange={(event) =>
											update({
												destinationType: event.target.value as DestinationType,
											})
										}
									/>
									{showBankDetails ? (
										<>
											{showBankPicker ? (
												<SelectField
													id="bank-endpoint"
													label="Bank account"
													value={
														matchingBankEndpoints.length === 0
															? NEW_BANK_ENDPOINT
															: bankEndpointChoice
													}
													disabled={authBlocked}
													options={[
														...matchingBankEndpoints.map((endpoint) => ({
															value: endpoint.id,
															label: bankEndpointLabel(endpoint.details),
														})),
														{
															value: NEW_BANK_ENDPOINT,
															label: "Add a new bank account",
														},
													]}
													hint="We hide most of the number to keep it safe."
													data-testid="bank-endpoint"
													onChange={(event) =>
														setBankEndpointChoice(event.target.value)
													}
												/>
											) : null}
											{bankEndpointsError ? (
												<Notice
													tone="warning"
													data-testid="bank-endpoints-error"
												>
													{bankEndpointsError}
												</Notice>
											) : null}
											{enteringNewBank ? (
												<BankDetailsFields
													value={bankDetails}
													disabled={authBlocked}
													requiredKeys={requiredBankKeys}
													onChange={setBankDetails}
												/>
											) : null}
											{addressRequired ? (
												<fieldset
													className="bank-details"
													data-testid="recipient-address"
												>
													<legend className="bank-details__legend">
														Recipient address
													</legend>
													<div className="form-grid">
														<TextField
															id="recipient-address-line1"
															label="Address line 1 (required)"
															value={address.line1}
															autoComplete="address-line1"
															onChange={(event) =>
																setAddress((current) => ({
																	...current,
																	line1: event.target.value,
																}))
															}
														/>
														<TextField
															id="recipient-address-line2"
															label="Address line 2"
															value={address.line2}
															autoComplete="address-line2"
															onChange={(event) =>
																setAddress((current) => ({
																	...current,
																	line2: event.target.value,
																}))
															}
														/>
														<TextField
															id="recipient-address-city"
															label="City (required)"
															value={address.city}
															autoComplete="address-level2"
															onChange={(event) =>
																setAddress((current) => ({
																	...current,
																	city: event.target.value,
																}))
															}
														/>
														<TextField
															id="recipient-address-state"
															label="State (required)"
															value={address.state}
															autoComplete="address-level1"
															onChange={(event) =>
																setAddress((current) => ({
																	...current,
																	state: event.target.value,
																}))
															}
														/>
														<TextField
															id="recipient-address-postal-code"
															label="Postal code (required)"
															value={address.postalCode}
															autoComplete="postal-code"
															onChange={(event) =>
																setAddress((current) => ({
																	...current,
																	postalCode: event.target.value,
																}))
															}
														/>
													</div>
												</fieldset>
											) : null}
										</>
									) : null}
								</div>
							</fieldset>
							<fieldset className="send-step">
								<legend className="send-step__title">
									<span className="send-step__num">3</span>
									How much, and how do you pay?
								</legend>
								<div className="form-grid">
									{showSendFrom ? (
										<SelectField
											id="send-from"
											label="Send from"
											value={form.sourceKey || sourceKey(source)}
											disabled={authBlocked}
											options={sendFromOptions.map((entry) => ({
												value: sourceKey(entry),
												label: sendFromLabel(entry),
											}))}
											hint="Where your money comes from."
											data-testid="send-from"
											onChange={(event) => changeSendFrom(event.target.value)}
										/>
									) : (
										<StaticField
											label="Source"
											value={sourceStaticLabel(source)}
											hint="Set by destination country"
										/>
									)}
									<TextField
										id="amount"
										label={amountCopy.label}
										placeholder={amountCopy.placeholder}
										inputMode="decimal"
										value={form.amount}
										hint={amountCopy.hint}
										onChange={(event) => update({ amount: event.target.value })}
									/>
									{senderWallet ? null : (
										<SelectField
											id="fee-mode"
											label="Who pays the fee?"
											value={form.feeMode}
											options={[
												{ value: "", label: "Choose who pays the fee" },
												...FEE_MODE_OPTIONS,
											]}
											hint="1% fee: added to what you pay, or taken from what they get."
											onChange={(event) =>
												update({ feeMode: event.target.value as FeeMode | "" })
											}
										/>
									)}
									<label className="field">
										<input
											type="checkbox"
											checked={senderWallet}
											data-testid="sender-wallet-blindpay"
											onChange={(event) =>
												setSenderWallet(event.target.checked)
											}
										/>{" "}
										Pay from my own Solana wallet
									</label>
								</div>
							</fieldset>
						</div>

						{formError ? <Notice tone="warning">{formError}</Notice> : null}
						{quoteError?.code === "kyc_required" ? (
							<SenderKycPanel details={quoteError.details} />
						) : null}
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
							<Button type="submit" disabled={quotePending || authBlocked}>
								{quotePending
									? "Getting quote…"
									: authBlocked
										? "Authentication required"
										: "Get quote"}
							</Button>
							<span className="form-note">
								You see the price first. Nothing is paid yet.
							</span>
						</div>
					</form>
				</Panel>

				<QuotePanel
					quote={quote}
					delivery={delivery}
					onCreate={() => void handleCreate()}
					creating={creating}
					authBlocked={authBlocked}
					expired={countdown.expired}
					validityLabel={countdown.label}
					createError={createError}
				/>
			</div>
		</Page>
	)
}
