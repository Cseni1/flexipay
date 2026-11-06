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
	destinationsForCountry,
	summarizeCorridor,
	type CorridorSummary,
} from "../api/corridors"
import {
	Button,
	EmptyState,
	Grid,
	Notice,
	Page,
	PageHeader,
	Panel,
	SelectField,
	SimulatedLabel,
	TextField,
} from "../components/ui"

const RECIPIENT_KIND_OPTIONS: { value: RecipientKind; label: string }[] = [
	{ value: "individual", label: "Individual" },
	{ value: "company", label: "Company" },
]

const ENDPOINT_TYPE_OPTIONS: { value: EndpointType; label: string }[] = [
	{ value: "bank_account", label: "Bank account" },
	{ value: "ewallet", label: "E-wallet" },
	{ value: "crypto_wallet", label: "Crypto wallet" },
	{ value: "crypto_custodial", label: "Crypto custodial" },
]

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

const formatDetail = (details: Record<string, string>): string =>
	Object.entries(details)
		.map(([key, value]) => `${key}: ${value}`)
		.join(" · ")

export default function Recipients() {
	const recipientFormId = useId()
	const endpointFormId = useId()
	const [recipients, setRecipients] = useState<RecipientSummary[]>([])
	const [endpoints, setEndpoints] = useState<EndpointSummary[]>([])
	const [corridors, setCorridors] = useState<CorridorSummary[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [selectedId, setSelectedId] = useState<string>("")

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
	const [creatingEndpoint, setCreatingEndpoint] = useState(false)
	const [endpointError, setEndpointError] = useState<string | null>(null)

	const loadAbort = useRef<AbortController | null>(null)
	const createRecipientAbort = useRef<AbortController | null>(null)
	const createEndpointAbort = useRef<AbortController | null>(null)

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
						: "Could not load recipients.",
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
	const selectedEndpoints = endpoints.filter(
		(entry) => entry.recipientId === selectedId,
	)

	const onCreateRecipient = async (event: FormEvent) => {
		event.preventDefault()
		const trimmed = name.trim()
		if (!trimmed || !country) {
			setRecipientError("Name and country are required.")
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
			setName("")
		} catch (cause) {
			if (controller.signal.aborted) return
			setRecipientError(
				cause instanceof ApiError
					? describeApiError(cause)
					: "Could not create recipient.",
			)
		} finally {
			if (!controller.signal.aborted) setCreatingRecipient(false)
		}
	}

	const onCreateEndpoint = async (event: FormEvent) => {
		event.preventDefault()
		if (!selected) {
			setEndpointError("Select a recipient first.")
			return
		}
		const detail = endpointDetail.trim()
		if (!detail) {
			setEndpointError(`${detailLabelFor(endpointType)} is required.`)
			return
		}
		const isCrypto = CRYPTO_TYPES.has(endpointType)
		if (!isCrypto && (!endpointCountry || !endpointCurrency)) {
			setEndpointError("Country and currency come from the corridor list.")
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
					details: { [detailKeyFor(endpointType)]: detail },
					simulated: true,
				},
				`endpoint-${globalThis.crypto.randomUUID()}`,
				controller.signal,
			)
			if (controller.signal.aborted) return
			setEndpoints((current) => [created, ...current])
			setEndpointDetail("")
		} catch (cause) {
			if (controller.signal.aborted) return
			setEndpointError(
				cause instanceof ApiError
					? describeApiError(cause)
					: "Could not create endpoint.",
			)
		} finally {
			if (!controller.signal.aborted) setCreatingEndpoint(false)
		}
	}

	const countryOptions = [{ value: "", label: "Select country" }, ...countries]

	return (
		<Page>
			<PageHeader
				eyebrow="Directory"
				title="Recipients"
				description="People and companies you pay, and how each prefers to be paid."
				actions={
					<Button variant="secondary" onClick={refresh} disabled={loading}>
						Refresh
					</Button>
				}
			/>

			{error ? (
				<Notice tone="warning" data-testid="recipients-error">
					Could not load recipients: {error}
				</Notice>
			) : null}

			<Grid columns={2}>
				<Panel
					title="Your recipients"
					description="From GET /v1/recipients. Select a row to manage payout endpoints."
				>
					{loading ? (
						<p className="form-note">Loading recipients…</p>
					) : recipients.length === 0 ? (
						<EmptyState title="No recipients yet">
							Add someone with the form on the right.
						</EmptyState>
					) : (
						<div className="table-scroll" data-testid="recipients-table">
							<table className="history-table">
								<thead>
									<tr>
										<th>Name</th>
										<th>Type</th>
										<th>Country</th>
										<th />
									</tr>
								</thead>
								<tbody>
									{recipients.map((recipient) => (
										<tr
											key={recipient.id}
											data-recipient-id={recipient.id}
											aria-selected={recipient.id === selectedId}
											className={
												recipient.id === selectedId
													? "recipients-row recipients-row--selected"
													: "recipients-row"
											}
										>
											<td>
												<button
													type="button"
													className="recipients-row__select"
													onClick={() => setSelectedId(recipient.id)}
												>
													{recipient.name}
												</button>
												<div className="hint mono">{recipient.id}</div>
											</td>
											<td>{recipient.kind}</td>
											<td>{recipient.country}</td>
											<td className="num">
												<Link
													className="button button--secondary button--sm"
													to={`/?recipientId=${encodeURIComponent(recipient.id)}`}
												>
													Pay
												</Link>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</Panel>

				<Panel title="Add a recipient" description="POST /v1/recipients">
					<form
						id={recipientFormId}
						onSubmit={(event) => void onCreateRecipient(event)}
					>
						<TextField
							label="Name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							autoComplete="off"
							required
						/>
						<SelectField
							label="Type"
							value={kind}
							options={RECIPIENT_KIND_OPTIONS}
							onChange={(event) => setKind(event.target.value as RecipientKind)}
						/>
						<SelectField
							label="Country"
							value={country}
							options={countryOptions}
							onChange={(event) => setCountry(event.target.value)}
							required
							hint={
								countries.length === 0
									? "Countries come from GET /v1/corridors once it loads."
									: undefined
							}
						/>
						{recipientError ? (
							<Notice tone="warning">{recipientError}</Notice>
						) : null}
						<Button
							type="submit"
							disabled={creatingRecipient || countries.length === 0}
						>
							{creatingRecipient ? "Adding…" : "Add recipient"}
						</Button>
					</form>
				</Panel>
			</Grid>

			<Panel
				title={
					selected
						? `Payout endpoints for ${selected.name}`
						: "Payout endpoints"
				}
				description="From GET /v1/endpoints. Every endpoint is simulated."
				actions={<SimulatedLabel />}
			>
				{!selected ? (
					<EmptyState title="Select a recipient">
						Choose someone above to see or add payout endpoints.
					</EmptyState>
				) : (
					<>
						{selectedEndpoints.length === 0 ? (
							<EmptyState title="No endpoints yet">
								Add a bank, e-wallet or crypto destination below.
							</EmptyState>
						) : (
							<div className="table-scroll" data-testid="endpoints-table">
								<table className="history-table">
									<thead>
										<tr>
											<th>Type</th>
											<th>Country / network</th>
											<th>Currency</th>
											<th>Details</th>
											<th />
										</tr>
									</thead>
									<tbody>
										{selectedEndpoints.map((endpoint) => (
											<tr key={endpoint.id} data-endpoint-id={endpoint.id}>
												<td>{typeLabel(endpoint.type)}</td>
												<td>
													{endpoint.network
														? endpoint.network
														: endpoint.country || "—"}
												</td>
												<td>{endpoint.currency}</td>
												<td className="mono">
													{formatDetail(endpoint.details)}
												</td>
												<td>
													{endpoint.simulated ? <SimulatedLabel /> : null}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}

						<form
							id={endpointFormId}
							className="recipients-endpoint-form"
							onSubmit={(event) => void onCreateEndpoint(event)}
							data-testid="endpoint-form"
						>
							<h3 className="panel__title">Add endpoint</h3>
							<p className="panel__description">
								POST /v1/endpoints with <code>simulated: true</code>.
							</p>
							<SelectField
								label="Type"
								value={endpointType}
								options={ENDPOINT_TYPE_OPTIONS}
								onChange={(event) => {
									const next = event.target.value
									if (!isEndpointType(next)) return
									setEndpointType(next)
									setEndpointDetail("")
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
											event.target.value === "stellar" ? "stellar" : "solana",
										)
									}
								/>
							) : (
								<SelectField
									label="Country"
									value={endpointCountry}
									options={countryOptions}
									onChange={(event) => setEndpointCountry(event.target.value)}
									required
								/>
							)}
							{!CRYPTO_TYPES.has(endpointType) ? (
								<TextField
									label="Currency"
									value={endpointCurrency}
									readOnly
									hint="Taken from the corridor for this country and type."
								/>
							) : (
								<TextField label="Currency" value="USDC" readOnly />
							)}
							<TextField
								label={detailLabelFor(endpointType)}
								value={endpointDetail}
								onChange={(event) => setEndpointDetail(event.target.value)}
								required
								autoComplete="off"
							/>
							{endpointError ? (
								<Notice tone="warning">{endpointError}</Notice>
							) : null}
							<Button
								type="submit"
								disabled={
									creatingEndpoint ||
									(!CRYPTO_TYPES.has(endpointType) &&
										(!endpointCountry || !endpointCurrency))
								}
							>
								{creatingEndpoint ? "Adding…" : "Add endpoint"}
							</Button>
						</form>
					</>
				)}
			</Panel>
		</Page>
	)
}
