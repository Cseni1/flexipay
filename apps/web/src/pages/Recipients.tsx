import {
	type EndpointType,
	type RecipientKind,
} from "@flexipay/web-lib/contract"
import {
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	type FormEvent,
} from "react"
import { Link } from "react-router-dom"
import {
	ApiError,
	createEndpoint,
	createRecipient,
	describeApiError,
	listCorridors,
	listEndpoints,
	listRecipients,
	type EndpointSummary,
	type RecipientSummary,
} from "../api/client"
import {
	countriesFromCorridors,
	countryLabel,
	destinationsForCountry,
	summarizeCorridor,
	type CorridorSummary,
} from "../api/corridors"
import { BankDetailsFields } from "../components/payments/BankDetailsFields"
import {
	Button,
	EmptyState,
	Notice,
	Page,
	PageHeader,
	SelectField,
	SimulatedLabel,
	TextField,
} from "../components/ui"
import { Icon, type IconName } from "../components/ui/Icon"
import {
	EMPTY_BANK_DETAILS,
	bankDetailsPayload,
	bankEndpointLabel,
	type BankDetailsForm,
} from "../payments/bankDetails"
import "../styles/pages/people.css"

const RECIPIENT_KIND_OPTIONS: { value: RecipientKind; label: string }[] = [
	{ value: "individual", label: "Person" },
	{ value: "company", label: "Business" },
]

const ENDPOINT_TYPE_OPTIONS: { value: EndpointType; label: string }[] = [
	{ value: "bank_account", label: "Bank account" },
	{ value: "ewallet", label: "Mobile wallet" },
	{ value: "crypto_wallet", label: "Crypto wallet" },
	{ value: "crypto_custodial", label: "Crypto account" },
]

const ENDPOINT_ICONS: Record<EndpointType, IconName> = {
	bank_account: "bank",
	ewallet: "phone",
	crypto_wallet: "wallet",
	crypto_custodial: "coin",
}

const CRYPTO_TYPES = new Set<EndpointType>([
	"crypto_wallet",
	"crypto_custodial",
])

const isEndpointType = (value: string): value is EndpointType =>
	ENDPOINT_TYPE_OPTIONS.some((option) => option.value === value)

const detailKeyFor = (
	type: EndpointType,
): "accountNumber" | "phoneNumber" | "address" => {
	if (type === "bank_account") return "accountNumber"
	if (type === "ewallet") return "phoneNumber"
	return "address"
}

const detailLabelFor = (type: EndpointType): string => {
	if (type === "bank_account") return "Account number"
	if (type === "ewallet") return "Phone number"
	return "Address"
}

const typeLabel = (type: EndpointType): string =>
	ENDPOINT_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type

const kindLabel = (kind: string): string =>
	kind === "company" ? "Business" : "Person"

const DETAIL_WORDS: Record<string, string> = {
	phoneNumber: "Phone",
	address: "Address",
	accountNumber: "Account",
}

const formatDetail = (
	type: EndpointType,
	details: Record<string, string>,
): string => {
	if (type === "bank_account") return bankEndpointLabel(details)
	return Object.entries(details)
		.map(([key, value]) => `${DETAIL_WORDS[key] ?? key} ${value}`)
		.join(" · ")
}

const initial = (name: string): string =>
	(name.trim().match(/\p{L}|\d/u)?.[0] ?? "?").toUpperCase()

/** Regional-indicator flag for a two-letter country code ("" when unknown). */
const flagFor = (country: string): string =>
	/^[A-Z]{2}$/.test(country)
		? String.fromCodePoint(
				...[...country].map((letter) => 0x1f1a5 + letter.charCodeAt(0)),
			)
		: ""

const countryText = (country: string): string =>
	country ? countryLabel(country) : "No country"

/** One plain line: how this person gets paid. */
const howPaid = (list: EndpointSummary[]): string => {
	const first = list[0]
	if (!first) return "No way to get paid yet"
	if (list.length > 1) return `${list.length} ways to get paid`
	return `${typeLabel(first.type)} · ${formatDetail(first.type, first.details)}`
}

export default function Recipients() {
	const recipientFormId = useId()
	const endpointFormId = useId()
	const [recipients, setRecipients] = useState<RecipientSummary[]>([])
	const [endpoints, setEndpoints] = useState<EndpointSummary[]>([])
	const [corridors, setCorridors] = useState<CorridorSummary[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [selectedId, setSelectedId] = useState<string>("")
	const [query, setQuery] = useState("")

	const [name, setName] = useState("")
	const [kind, setKind] = useState<RecipientKind>("individual")
	const [country, setCountry] = useState("")
	const [creatingRecipient, setCreatingRecipient] = useState(false)
	const [recipientError, setRecipientError] = useState<string | null>(null)

	const [endpointType, setEndpointType] = useState<EndpointType>("bank_account")
	const [endpointCountry, setEndpointCountry] = useState("")
	const [endpointCurrency, setEndpointCurrency] = useState("")
	const [endpointNetwork, setEndpointNetwork] = useState<"stellar" | "solana">(
		"solana",
	)
	const [endpointDetail, setEndpointDetail] = useState("")
	const [bankDetails, setBankDetails] =
		useState<BankDetailsForm>(EMPTY_BANK_DETAILS)
	const [creatingEndpoint, setCreatingEndpoint] = useState(false)
	const [endpointError, setEndpointError] = useState<string | null>(null)

	const loadAbort = useRef<AbortController | null>(null)
	const createRecipientAbort = useRef<AbortController | null>(null)
	const createEndpointAbort = useRef<AbortController | null>(null)
	const nameId = useId()
	const detailRef = useRef<HTMLElement | null>(null)

	const countries = useMemo(
		() => countriesFromCorridors(corridors),
		[corridors],
	)

	const destinationOptions = useMemo(() => {
		if (CRYPTO_TYPES.has(endpointType)) {
			return [
				{
					value: endpointType,
					label: typeLabel(endpointType),
					currency: "USDC",
				},
			]
		}
		if (!endpointCountry) return []
		return destinationsForCountry(corridors, endpointCountry).filter(
			(option) => option.value === endpointType,
		)
	}, [corridors, endpointCountry, endpointType])

	const endpointsByRecipient = useMemo(() => {
		const map = new Map<string, EndpointSummary[]>()
		for (const endpoint of endpoints) {
			const list = map.get(endpoint.recipientId) ?? []
			list.push(endpoint)
			map.set(endpoint.recipientId, list)
		}
		return map
	}, [endpoints])

	const refresh = () => {
		loadAbort.current?.abort()
		const controller = new AbortController()
		loadAbort.current = controller
		setLoading(true)
		setError(null)
		void Promise.all([
			listRecipients(controller.signal),
			listEndpoints({ signal: controller.signal }),
			listCorridors(controller.signal),
		])
			.then(([recipientList, endpointList, corridorList]) => {
				if (controller.signal.aborted) return
				setRecipients(recipientList.recipients)
				setEndpoints(endpointList.endpoints)
				setCorridors(corridorList.corridors.map(summarizeCorridor))
				setSelectedId((current) => {
					if (
						current &&
						recipientList.recipients.some((entry) => entry.id === current)
					) {
						return current
					}
					return recipientList.recipients[0]?.id ?? ""
				})
			})
			.catch((cause) => {
				if (controller.signal.aborted) return
				setError(
					cause instanceof ApiError
						? describeApiError(cause)
						: "Could not load your people.",
				)
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false)
			})
	}

	useEffect(() => {
		refresh()
		return () => {
			loadAbort.current?.abort()
			createRecipientAbort.current?.abort()
			createEndpointAbort.current?.abort()
		}
	}, [])

	useEffect(() => {
		if (CRYPTO_TYPES.has(endpointType)) {
			setEndpointCountry("")
			setEndpointCurrency("USDC")
			return
		}
		const match = destinationOptions[0]
		if (match) setEndpointCurrency(match.currency)
		else if (!endpointCountry) setEndpointCurrency("")
	}, [destinationOptions, endpointCountry, endpointType])

	const selected = recipients.find((entry) => entry.id === selectedId) ?? null
	const selectedEndpoints = endpointsByRecipient.get(selectedId) ?? []

	const needle = query.trim().toLowerCase()
	const shownRecipients = needle
		? recipients.filter(
				(entry) =>
					entry.name.toLowerCase().includes(needle) ||
					countryText(entry.country).toLowerCase().includes(needle),
			)
		: recipients

	const choose = (id: string) => {
		setSelectedId(id)
		// On a phone the details sit below the list: bring them into view.
		if (
			typeof window !== "undefined" &&
			window.matchMedia?.("(max-width: 900px)").matches
		) {
			detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
		}
	}

	const startAdding = () => {
		const input = document.getElementById(nameId)
		input?.scrollIntoView({ behavior: "smooth", block: "center" })
		input?.focus({ preventScroll: true })
	}

	const onCreateRecipient = async (event: FormEvent) => {
		event.preventDefault()
		const trimmed = name.trim()
		if (!trimmed || !country) {
			setRecipientError("Please add a name and a country.")
			return
		}
		createRecipientAbort.current?.abort()
		const controller = new AbortController()
		createRecipientAbort.current = controller
		setCreatingRecipient(true)
		setRecipientError(null)
		try {
			const created = await createRecipient(
				{ name: trimmed, kind, country },
				`recipient-${globalThis.crypto.randomUUID()}`,
				controller.signal,
			)
			if (controller.signal.aborted) return
			const listed = await listRecipients(controller.signal)
			if (controller.signal.aborted) return
			setRecipients(listed.recipients)
			setSelectedId(created.id)
			setEndpointCountry((current) => current || country)
			setName("")
		} catch (cause) {
			if (controller.signal.aborted) return
			setRecipientError(
				cause instanceof ApiError
					? describeApiError(cause)
					: "Could not add this person.",
			)
		} finally {
			if (!controller.signal.aborted) setCreatingRecipient(false)
		}
	}

	const onCreateEndpoint = async (event: FormEvent) => {
		event.preventDefault()
		if (!selected) {
			setEndpointError("Pick a person first.")
			return
		}
		const isBank = endpointType === "bank_account"
		const detail = endpointDetail.trim()
		if (isBank && !bankDetails.accountNumber.trim()) {
			setEndpointError("Please add the account number.")
			return
		}
		if (!isBank && !detail) {
			setEndpointError(
				`Please add the ${detailLabelFor(endpointType).toLowerCase()}.`,
			)
			return
		}
		const isCrypto = CRYPTO_TYPES.has(endpointType)
		if (!isCrypto && (!endpointCountry || !endpointCurrency)) {
			setEndpointError("Pick a country we can pay to.")
			return
		}
		createEndpointAbort.current?.abort()
		const controller = new AbortController()
		createEndpointAbort.current = controller
		setCreatingEndpoint(true)
		setEndpointError(null)
		try {
			const created = await createEndpoint(
				{
					recipientId: selected.id,
					type: endpointType,
					country: isCrypto ? "" : endpointCountry,
					currency: isCrypto ? "USDC" : endpointCurrency,
					network: isCrypto ? endpointNetwork : null,
					details: isBank
						? bankDetailsPayload(bankDetails)
						: { [detailKeyFor(endpointType)]: detail },
					simulated: true,
				},
				`endpoint-${globalThis.crypto.randomUUID()}`,
				controller.signal,
			)
			if (controller.signal.aborted) return
			setEndpoints((current) => [created, ...current])
			setEndpointDetail("")
			setBankDetails(EMPTY_BANK_DETAILS)
		} catch (cause) {
			if (controller.signal.aborted) return
			setEndpointError(
				cause instanceof ApiError
					? describeApiError(cause)
					: "Could not save this way to get paid.",
			)
		} finally {
			if (!controller.signal.aborted) setCreatingEndpoint(false)
		}
	}

	const countryOptions = [
		{ value: "", label: "Choose a country" },
		...countries,
	]
	const wayCountryOptions = [{ value: "", label: "Choose…" }, ...countries]
	const payTo = (id: string) => `/?recipientId=${encodeURIComponent(id)}`

	return (
		<Page>
			<PageHeader
				eyebrow="Your people"
				title="People"
				description="Everyone you pay, and how they like to get their money."
				actions={
					<>
						<Button
							variant="secondary"
							onClick={refresh}
							disabled={loading}
							aria-label="Refresh"
						>
							<Icon name="refresh" size={18} />
							<span className="people-hide-sm">Refresh</span>
						</Button>
						<Button onClick={startAdding}>
							<Icon name="plus" size={18} />
							Add a person
						</Button>
					</>
				}
			/>

			{error ? (
				<Notice tone="warning" data-testid="recipients-error">
					Could not load your people: {error}
				</Notice>
			) : null}

			<div
				className={
					recipients.length > 0
						? "people-layout"
						: "people-layout people-layout--solo"
				}
			>
				<section
					className="panel people-list"
					aria-labelledby="people-list-title"
				>
					<header className="people-list__head">
						<div>
							<h3 className="panel__title" id="people-list-title">
								Your people
							</h3>
							<p className="panel__description">
								{loading
									? "Loading…"
									: recipients.length === 1
										? "1 person"
										: `${recipients.length} people`}
							</p>
						</div>
						{recipients.length > 3 ? (
							<label className="people-search">
								<Icon name="search" size={18} />
								<input
									type="search"
									placeholder="Find a person"
									aria-label="Find a person"
									value={query}
									onChange={(event) => setQuery(event.target.value)}
								/>
							</label>
						) : null}
					</header>

					{loading ? (
						<ul className="people-cards" aria-hidden="true">
							{[0, 1, 2].map((key) => (
								<li key={key} className="people-card people-card--ghost" />
							))}
						</ul>
					) : recipients.length === 0 ? (
						<div className="people-empty">
							<span className="people-empty__icon" aria-hidden="true">
								<Icon name="people" size={28} />
							</span>
							<p className="people-empty__title">No people yet</p>
							<p className="people-empty__text">
								Add the first person you want to pay. It takes a few seconds.
							</p>
							<Button onClick={startAdding}>
								<Icon name="plus" size={18} />
								Add a person
							</Button>
						</div>
					) : (
						<ul className="people-cards" data-testid="recipients-table">
							{shownRecipients.map((recipient) => {
								const isSelected = recipient.id === selectedId
								const list = endpointsByRecipient.get(recipient.id) ?? []
								return (
									<li
										key={recipient.id}
										data-recipient-id={recipient.id}
										aria-selected={isSelected}
										className={
											isSelected
												? "people-card people-card--selected"
												: "people-card"
										}
									>
										<button
											type="button"
											className="people-card__select"
											aria-pressed={isSelected}
											onClick={() => choose(recipient.id)}
										>
											<span className="people-avatar" aria-hidden="true">
												{initial(recipient.name)}
											</span>
											<span className="people-card__text">
												<span className="people-card__name">
													{recipient.name}
												</span>
												<span className="people-card__meta">
													<span aria-hidden="true">
														{flagFor(recipient.country)}
													</span>{" "}
													{countryText(recipient.country)} ·{" "}
													{kindLabel(recipient.kind)}
												</span>
												<span
													className={
														list.length
															? "people-card__how"
															: "people-card__how people-card__how--none"
													}
												>
													{howPaid(list)}
												</span>
											</span>
										</button>
										<Link
											className="button button--secondary people-card__pay"
											to={payTo(recipient.id)}
											aria-label={`Pay ${recipient.name}`}
										>
											Pay
										</Link>
									</li>
								)
							})}
							{shownRecipients.length === 0 ? (
								<li className="people-none">Nobody called “{query.trim()}”.</li>
							) : null}
						</ul>
					)}
				</section>

				<section
					className="panel people-add"
					aria-labelledby="people-add-title"
				>
					<header className="people-add__head">
						<span className="people-add__icon" aria-hidden="true">
							<Icon name="plus" size={20} />
						</span>
						<div>
							<h3 className="panel__title" id="people-add-title">
								Add a person
							</h3>
							<p className="panel__description">
								Just a name and where they live. Bank details come next.
							</p>
						</div>
					</header>
					<form
						id={recipientFormId}
						className="people-add__form"
						onSubmit={(event) => void onCreateRecipient(event)}
					>
						<TextField
							id={nameId}
							label="Name"
							value={name}
							placeholder="e.g. Maria Santos"
							onChange={(event) => setName(event.target.value)}
							autoComplete="off"
							required
						/>
						<fieldset className="people-kind">
							<legend className="field__label">Who is it?</legend>
							<div className="people-kind__options">
								{RECIPIENT_KIND_OPTIONS.map((option) => (
									<label
										key={option.value}
										className={
											kind === option.value
												? "people-kind__option people-kind__option--on"
												: "people-kind__option"
										}
									>
										<input
											type="radio"
											name={`${recipientFormId}-kind`}
											value={option.value}
											checked={kind === option.value}
											onChange={() => setKind(option.value)}
										/>
										<Icon
											name={option.value === "company" ? "building" : "user"}
											size={18}
										/>
										{option.label}
									</label>
								))}
							</div>
						</fieldset>
						<SelectField
							label="Country"
							value={country}
							options={countryOptions}
							onChange={(event) => setCountry(event.target.value)}
							required
							hint={
								countries.length === 0
									? "The country list appears once we are connected."
									: undefined
							}
						/>
						{recipientError ? (
							<Notice tone="warning">{recipientError}</Notice>
						) : null}
						<Button
							type="submit"
							className="people-submit"
							disabled={creatingRecipient || countries.length === 0}
						>
							{creatingRecipient ? "Adding…" : "Add person"}
						</Button>
					</form>
				</section>
				{recipients.length > 0 ? (
					<section
						className="panel people-detail"
						ref={detailRef}
						data-testid="recipient-detail"
						aria-label="Person details"
					>
						{!selected ? (
							<div className="people-detail__body">
								<EmptyState title="Pick a person">
									Choose someone from your list to see how they get paid.
								</EmptyState>
							</div>
						) : (
							<>
								<header className="people-hero">
									<span
										className="people-avatar people-avatar--lg"
										aria-hidden="true"
									>
										{initial(selected.name)}
									</span>
									<div className="people-hero__text">
										<h3 className="people-hero__name">{selected.name}</h3>
										<p className="people-hero__meta">
											<span className="people-tag">
												<span aria-hidden="true">
													{flagFor(selected.country)}
												</span>{" "}
												{countryText(selected.country)}
											</span>
											<span className="people-tag">
												<Icon
													name={
														selected.kind === "company" ? "building" : "user"
													}
													size={14}
												/>
												{kindLabel(selected.kind)}
											</span>
										</p>
									</div>
									<Link
										className="button button--primary people-hero__pay"
										to={payTo(selected.id)}
									>
										<Icon name="send" size={18} />
										Pay {selected.name}
									</Link>
								</header>

								<div className="people-detail__body">
									<div className="people-section-head">
										<h4 className="people-section-title">Ways to get paid</h4>
									</div>

									{selectedEndpoints.length === 0 ? (
										<div className="people-nothing">
											<Icon name="card" size={22} />
											<p>
												No way to get paid yet. Add their bank account below.
											</p>
										</div>
									) : (
										<ul className="people-ways" data-testid="endpoints-table">
											{selectedEndpoints.map((endpoint) => (
												<li
													key={endpoint.id}
													className="people-way"
													data-endpoint-id={endpoint.id}
												>
													<span className="people-way__icon" aria-hidden="true">
														<Icon
															name={ENDPOINT_ICONS[endpoint.type]}
															size={20}
														/>
													</span>
													<span className="people-way__text">
														<span className="people-way__type">
															{typeLabel(endpoint.type)}
														</span>
														<span
															className="people-way__detail"
															data-testid={`endpoint-details-${endpoint.id}`}
														>
															{formatDetail(endpoint.type, endpoint.details)}
														</span>
													</span>
													<span className="people-way__side">
														<span className="people-way__currency">
															{endpoint.network
																? `${endpoint.currency} on ${endpoint.network === "stellar" ? "Stellar" : "Solana"}`
																: endpoint.currency}
														</span>
														{endpoint.simulated ? <SimulatedLabel /> : null}
													</span>
												</li>
											))}
										</ul>
									)}

									<form
										id={endpointFormId}
										className="people-way-form"
										onSubmit={(event) => void onCreateEndpoint(event)}
										data-testid="endpoint-form"
									>
										<h4 className="people-section-title">
											<Icon name="plus" size={18} />
											Add a way to get paid
										</h4>
										<div className="people-form-grid">
											<SelectField
												label="How they get paid"
												value={endpointType}
												options={ENDPOINT_TYPE_OPTIONS}
												onChange={(event) => {
													const next = event.target.value
													if (!isEndpointType(next)) return
													setEndpointType(next)
													setEndpointDetail("")
													setBankDetails(EMPTY_BANK_DETAILS)
												}}
											/>
											{CRYPTO_TYPES.has(endpointType) ? (
												<SelectField
													label="Network"
													value={endpointNetwork}
													options={[
														{ value: "solana", label: "Solana" },
														{ value: "stellar", label: "Stellar" },
													]}
													onChange={(event) =>
														setEndpointNetwork(
															event.target.value === "stellar"
																? "stellar"
																: "solana",
														)
													}
												/>
											) : (
												<SelectField
													label="Country"
													value={endpointCountry}
													options={wayCountryOptions}
													onChange={(event) =>
														setEndpointCountry(event.target.value)
													}
													required
												/>
											)}
											<TextField
												label="Currency"
												value={
													CRYPTO_TYPES.has(endpointType)
														? "USDC"
														: endpointCurrency
												}
												placeholder="—"
												readOnly
												title="Set for you by the country"
											/>
										</div>
										{endpointType === "bank_account" ? (
											<BankDetailsFields
												value={bankDetails}
												onChange={setBankDetails}
												data-testid="recipient-bank-details"
											/>
										) : (
											<TextField
												label={detailLabelFor(endpointType)}
												value={endpointDetail}
												onChange={(event) =>
													setEndpointDetail(event.target.value)
												}
												required
												autoComplete="off"
											/>
										)}
										{endpointError ? (
											<Notice tone="warning">{endpointError}</Notice>
										) : null}
										<Button
											type="submit"
											className="people-submit"
											disabled={
												creatingEndpoint ||
												(!CRYPTO_TYPES.has(endpointType) &&
													(!endpointCountry || !endpointCurrency))
											}
										>
											{creatingEndpoint ? "Saving…" : "Save way to get paid"}
										</Button>
									</form>

									<details className="people-more">
										<summary>More details</summary>
										<dl>
											<dt>Added</dt>
											<dd>
												{new Date(selected.createdAt).toLocaleDateString(
													"en-GB",
													{
														day: "numeric",
														month: "short",
														year: "numeric",
													},
												)}
											</dd>
											<dt>Reference</dt>
											<dd className="mono">{selected.id}</dd>
										</dl>
									</details>
								</div>
							</>
						)}
					</section>
				) : null}
			</div>
		</Page>
	)
}
