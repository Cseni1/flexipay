import {
	PaymentDetailSchema,
	PaymentListResponseSchema,
	type PaymentListResponse,
	BlindPayConfirmResponseSchema,
	BlindPayDelegationResponseSchema,
	BlindPayKycBodySchema,
	BlindPayOnboardingResponseSchema,
	DueConfirmResponseSchema,
	DueFundingResponseSchema,
	PaymentSchema,
	SolanaConfirmPendingResponseSchema,
	QuoteSchema,
	SolanaSwapConfirmResponseSchema,
	SolanaSwapResponseSchema,
	type CreatePaymentRequest,
	type CreateQuoteRequest,
	type EndpointType,
	type Payment,
	type PaymentDetail,
	type Quote,
	type RecipientKind,
} from "@flexipay/web-lib/contract"

// The web app only calls the v1 API (ARCHITECTURE §5, §10). Responses are validated with the
// merged A0 schemas; no parallel quote or payment DTO is defined here. Every request is
// same-origin: the local Vite proxy adds the server-side Bearer credential. Browser code never
// reads FP_API_KEY nor sends an Authorization header.

export const SESSION_ENDED_MESSAGE =
	"Your sign-in has ended. Sign in again to continue."

// Set by SessionProvider: true while the caller is a signed-in customer (cookie session), so a
// 401 is reported as an ended session instead of a server-key problem.
let customerSessionActive = false
export const setCustomerSessionActive = (active: boolean): void => {
	customerSessionActive = active
}

/** Fired on any 401 from the API (see SessionProvider). */
export const UNAUTHORIZED_EVENT = "flexipay:unauthorized"

export const AUTH_NOT_CONFIGURED_MESSAGE =
	"The local web proxy is not configured with a server-side API key. Set FP_API_KEY for the Vite server and restart it."

export const API_KEY_REJECTED_MESSAGE =
	"The API rejected the server-side key. Check FP_API_KEY and restart the Vite server."

/** Shown while Render's free tier is cold-starting (slow fetch or 5xx). */
export const API_WAKE_UP_MESSAGE =
	"Waking up the server, this can take up to a minute"

/** Shown after automatic wake-up retries are exhausted. */
export const API_GAVE_UP_MESSAGE =
	"Something went wrong on our side. Try again, or contact support."

/** Per-request budget before we treat the API as asleep (cold host). */
export const API_REQUEST_TIMEOUT_MS = 15_000

const AUTH_BLOCKED_CODES = new Set([
	"auth_required",
	"unauthorized",
	"frontend_auth_not_configured",
	"frontend_api_not_configured",
])

export const isAuthRequired = (error: unknown): error is ApiError =>
	error instanceof ApiError &&
	(error.status === 401 || AUTH_BLOCKED_CODES.has(error.code))

/** Network / cold-start / 5xx — show the wake-up UI instead of raw errors. */
export const isTransientApiError = (error: unknown): boolean =>
	error instanceof ApiError &&
	!AUTH_BLOCKED_CODES.has(error.code) &&
	(error.code === "network_error" ||
		error.code === "api_waking" ||
		error.code === "internal_error" ||
		error.code.startsWith("http_5") ||
		error.status >= 500)

interface Parser<T> {
	parse: (value: unknown) => T
}

export class ApiError extends Error {
	readonly status: number
	readonly code: string
	readonly details: unknown

	constructor(
		status: number,
		code: string,
		message: string,
		details?: unknown,
	) {
		super(message)
		this.name = "ApiError"
		this.status = status
		this.code = code
		this.details = details
	}

	/** 422 reasons are part of the documented error envelope (ARCHITECTURE §10). */
	get reasons(): string[] {
		const details = this.details
		if (Array.isArray(details)) {
			return details.filter((item): item is string => typeof item === "string")
		}
		if (details && typeof details === "object" && "reasons" in details) {
			const reasons = (details as { reasons?: unknown }).reasons
			return Array.isArray(reasons)
				? reasons.filter((item): item is string => typeof item === "string")
				: []
		}
		return []
	}
}

interface RequestOptions<T> {
	method?: "GET" | "POST"
	body?: unknown
	/** CCR-46: a file sent as the raw body, with its own content type. */
	file?: Blob
	schema: Parser<T>
	idempotencyKey?: string
	signal?: AbortSignal
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null

async function request<T>(
	path: string,
	options: RequestOptions<T>,
): Promise<T> {
	const headers = new Headers({ Accept: "application/json" })
	if (options.file !== undefined)
		headers.set("Content-Type", options.file.type || "application/octet-stream")
	else if (options.body !== undefined)
		headers.set("Content-Type", "application/json")
	// No browser-side auth header. The same-origin proxy owns the Bearer credential.
	if (options.idempotencyKey)
		headers.set("Idempotency-Key", options.idempotencyKey)

	const timeout = new AbortController()
	const timer = setTimeout(() => timeout.abort(), API_REQUEST_TIMEOUT_MS)
	const signal =
		typeof AbortSignal !== "undefined" &&
		"any" in AbortSignal &&
		typeof AbortSignal.any === "function" &&
		options.signal
			? AbortSignal.any([options.signal, timeout.signal])
			: (options.signal ?? timeout.signal)

	let response: Response
	try {
		response = await fetch(path, {
			method: options.method ?? "GET",
			headers,
			body:
				options.file !== undefined
					? options.file
					: options.body === undefined
						? undefined
						: JSON.stringify(options.body),
			signal,
		})
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") {
			if (options.signal?.aborted) throw error
			throw new ApiError(0, "api_waking", API_WAKE_UP_MESSAGE)
		}
		throw new ApiError(0, "network_error", API_WAKE_UP_MESSAGE)
	} finally {
		clearTimeout(timer)
	}

	const text = await response.text()
	let payload: unknown = null
	if (text) {
		try {
			payload = JSON.parse(text)
		} catch {
			throw new ApiError(
				response.status,
				"invalid_response",
				`The API returned a non-JSON response (HTTP ${response.status}).`,
			)
		}
	}

	if (!response.ok) {
		const record = isRecord(payload) ? payload : {}
		const code =
			typeof record.code === "string" ? record.code : `http_${response.status}`
		// Tell the session layer so a customer whose session has ended is sent to /login.
		if (response.status === 401)
			(
				globalThis as { dispatchEvent?: (event: Event) => boolean }
			).dispatchEvent?.(new Event(UNAUTHORIZED_EVENT))
		const message =
			response.status === 401
				? customerSessionActive
					? SESSION_ENDED_MESSAGE
					: API_KEY_REJECTED_MESSAGE
				: code === "frontend_auth_not_configured"
					? AUTH_NOT_CONFIGURED_MESSAGE
					: response.status >= 500
						? API_WAKE_UP_MESSAGE
						: typeof record.message === "string"
							? record.message
							: `API request failed (HTTP ${response.status}).`
		throw new ApiError(
			response.status,
			response.status === 401 ? "auth_required" : code,
			message,
			record.details,
		)
	}

	try {
		return options.schema.parse(payload)
	} catch {
		throw new ApiError(
			response.status,
			"invalid_response",
			"The API response does not match the A0 contract.",
		)
	}
}

export const describeApiError = (error: ApiError): string =>
	isTransientApiError(error)
		? API_WAKE_UP_MESSAGE
		: [error.message, ...error.reasons].filter(Boolean).join(" ")

export const newIdempotencyKey = (prefix: string): string =>
	`${prefix}-${crypto.randomUUID()}`

export const createQuote = (
	input: CreateQuoteRequest,
	signal?: AbortSignal,
): Promise<Quote> =>
	request("/v1/quotes", {
		method: "POST",
		body: input,
		schema: QuoteSchema,
		idempotencyKey: newIdempotencyKey("quote"),
		signal,
	})

/** Fetch a previously created quote when the API still retains it (Demo Day savings). */
export const getQuote = (id: string, signal?: AbortSignal): Promise<Quote> =>
	request(`/v1/quotes/${encodeURIComponent(id)}`, {
		schema: QuoteSchema,
		signal,
	})

export interface RecipientAddressInput {
	line1: string
	line2?: string
	city: string
	state: string
	postalCode: string
	country: string
}

interface CreateRecipientInput {
	name: string
	kind: RecipientKind
	country: string
	address?: RecipientAddressInput
}

/** The create response is id-only in existing browser fixtures; list returns the full row. */
const recipientIdSchema: Parser<{ id: string }> = {
	parse: (value) => {
		if (
			!isRecord(value) ||
			typeof value.id !== "string" ||
			value.id.length === 0
		) {
			throw new Error("recipient id missing")
		}
		return { id: value.id }
	},
}

export interface RecipientSummary {
	id: string
	name: string
	kind: RecipientKind
	country: string
	address: RecipientAddressInput | null
	createdAt: string
}

const parseAddress = (value: unknown): RecipientAddressInput | null => {
	if (value == null) return null
	if (
		!isRecord(value) ||
		typeof value.line1 !== "string" ||
		typeof value.city !== "string" ||
		typeof value.state !== "string" ||
		typeof value.postalCode !== "string" ||
		typeof value.country !== "string"
	) {
		throw new Error("recipient address invalid")
	}
	return {
		line1: value.line1,
		...(typeof value.line2 === "string" ? { line2: value.line2 } : {}),
		city: value.city,
		state: value.state,
		postalCode: value.postalCode,
		country: value.country,
	}
}

const parseRecipient = (item: unknown): RecipientSummary => {
	if (
		!isRecord(item) ||
		typeof item.id !== "string" ||
		typeof item.name !== "string" ||
		typeof item.kind !== "string" ||
		typeof item.country !== "string" ||
		typeof item.createdAt !== "string"
	) {
		throw new Error("recipient row invalid")
	}
	return {
		id: item.id,
		name: item.name,
		kind: item.kind as RecipientKind,
		country: item.country,
		address: parseAddress(item.address),
		createdAt: item.createdAt,
	}
}

export interface PayoutRequirements {
	country: string
	currency: string
	providerId: string | null
	detailKeys: string[]
	localFields: string[]
	addressRequired: boolean
}

const payoutRequirementsSchema: Parser<PayoutRequirements> = {
	parse: (value) => {
		if (
			!isRecord(value) ||
			typeof value.country !== "string" ||
			typeof value.currency !== "string" ||
			!Array.isArray(value.detailKeys) ||
			!Array.isArray(value.localFields) ||
			typeof value.addressRequired !== "boolean"
		) {
			throw new Error("payout requirements invalid")
		}
		return {
			country: value.country,
			currency: value.currency,
			providerId:
				typeof value.providerId === "string" ? value.providerId : null,
			detailKeys: value.detailKeys.filter(
				(key): key is string => typeof key === "string",
			),
			localFields: value.localFields.filter(
				(key): key is string => typeof key === "string",
			),
			addressRequired: value.addressRequired,
		}
	},
}

export const getPayoutRequirements = (
	country: string,
	currency: string,
	signal?: AbortSignal,
): Promise<PayoutRequirements> => {
	const query = new URLSearchParams({ country, currency })
	return request(`/v1/payout-requirements?${query.toString()}`, {
		schema: payoutRequirementsSchema,
		signal,
	})
}

const recipientListSchema: Parser<{ recipients: RecipientSummary[] }> = {
	parse: (value) => {
		if (!isRecord(value) || !Array.isArray(value.recipients)) {
			throw new Error("recipients missing")
		}
		return { recipients: value.recipients.map(parseRecipient) }
	},
}

export const createRecipient = (
	input: CreateRecipientInput,
	idempotencyKey: string,
	signal?: AbortSignal,
): Promise<{ id: string }> =>
	request("/v1/recipients", {
		method: "POST",
		body: input,
		schema: recipientIdSchema,
		idempotencyKey,
		signal,
	})

export const listRecipients = (
	signal?: AbortSignal,
): Promise<{ recipients: RecipientSummary[] }> =>
	request("/v1/recipients", { schema: recipientListSchema, signal })
export interface EndpointSummary {
	id: string
	organizationId: string
	recipientId: string
	type: EndpointType
	country: string
	currency: string
	network: "stellar" | "solana" | null
	details: Record<string, string>
	simulated: true
	createdAt: string
}

const parseEndpoint = (item: unknown): EndpointSummary => {
	if (
		!isRecord(item) ||
		typeof item.id !== "string" ||
		typeof item.organizationId !== "string" ||
		typeof item.recipientId !== "string" ||
		typeof item.type !== "string" ||
		typeof item.country !== "string" ||
		typeof item.currency !== "string" ||
		(item.network !== null &&
			item.network !== "stellar" &&
			item.network !== "solana") ||
		!isRecord(item.details) ||
		item.simulated !== true ||
		typeof item.createdAt !== "string"
	) {
		throw new Error("endpoint row invalid")
	}
	const details: Record<string, string> = {}
	for (const [key, value] of Object.entries(item.details)) {
		if (typeof value !== "string") throw new Error("endpoint details invalid")
		details[key] = value
	}
	return {
		id: item.id,
		organizationId: item.organizationId,
		recipientId: item.recipientId,
		type: item.type as EndpointType,
		country: item.country,
		currency: item.currency,
		network: item.network,
		details,
		simulated: true,
		createdAt: item.createdAt,
	}
}

const endpointSchema: Parser<EndpointSummary> = { parse: parseEndpoint }

const endpointListSchema: Parser<{ endpoints: EndpointSummary[] }> = {
	parse: (value) => {
		if (!isRecord(value) || !Array.isArray(value.endpoints)) {
			throw new Error("endpoints missing")
		}
		return { endpoints: value.endpoints.map(parseEndpoint) }
	},
}

export interface CreateEndpointInput {
	recipientId: string
	type: EndpointType
	country: string
	currency: string
	network: "stellar" | "solana" | null
	details: Record<string, string>
	simulated: true
}

export const listEndpoints = (
	opts: { recipientId?: string; signal?: AbortSignal } = {},
): Promise<{ endpoints: EndpointSummary[] }> => {
	const query = opts.recipientId
		? `?recipientId=${encodeURIComponent(opts.recipientId)}`
		: ""
	return request(`/v1/endpoints${query}`, {
		schema: endpointListSchema,
		signal: opts.signal,
	})
}

export const createEndpoint = (
	input: CreateEndpointInput,
	idempotencyKey: string,
	signal?: AbortSignal,
): Promise<EndpointSummary> =>
	request("/v1/endpoints", {
		method: "POST",
		body: input,
		schema: endpointSchema,
		idempotencyKey,
		signal,
	})
export interface CorridorRow {
	from: { country: string; currency: string }
	to: { country: string; currency: string }
	allowedDestinationTypes: string[]
	recipientKinds: string[]
	regulationNote: string
	simulated: boolean
	/** Present when the API returns the full corridor (`legsAvailable.settle`). */
	settleRails?: string[]
	/** Present when the API returns payout provider ids (`legsAvailable.payout`). */
	payoutProviders?: string[]
}

const stringIds = (value: unknown): string[] | undefined =>
	Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: undefined

const corridorListSchema: Parser<{ corridors: CorridorRow[] }> = {
	parse: (value) => {
		if (!isRecord(value) || !Array.isArray(value.corridors)) {
			throw new Error("corridors missing")
		}
		const corridors = value.corridors.map((item) => {
			if (
				!isRecord(item) ||
				!isRecord(item.from) ||
				!isRecord(item.to) ||
				typeof item.from.country !== "string" ||
				typeof item.from.currency !== "string" ||
				typeof item.to.country !== "string" ||
				typeof item.to.currency !== "string" ||
				!Array.isArray(item.allowedDestinationTypes) ||
				!Array.isArray(item.recipientKinds) ||
				typeof item.regulationNote !== "string" ||
				typeof item.simulated !== "boolean"
			) {
				throw new Error("corridor row invalid")
			}
			const legs = isRecord(item.legsAvailable) ? item.legsAvailable : null
			const settleRails = legs ? stringIds(legs.settle) : undefined
			const payoutProviders = legs ? stringIds(legs.payout) : undefined
			return {
				from: {
					country: item.from.country,
					currency: item.from.currency,
				},
				to: { country: item.to.country, currency: item.to.currency },
				allowedDestinationTypes: item.allowedDestinationTypes.filter(
					(entry): entry is string => typeof entry === "string",
				),
				recipientKinds: item.recipientKinds.filter(
					(entry): entry is string => typeof entry === "string",
				),
				regulationNote: item.regulationNote,
				simulated: item.simulated,
				...(settleRails ? { settleRails } : {}),
				...(payoutProviders ? { payoutProviders } : {}),
			}
		})
		return { corridors }
	},
}

export const listCorridors = (
	signal?: AbortSignal,
): Promise<{ corridors: CorridorRow[] }> =>
	request("/v1/corridors", { schema: corridorListSchema, signal })

const healthSchema: Parser<{ status: "ok" }> = {
	parse: (value) => {
		if (!isRecord(value) || value.status !== "ok") {
			throw new Error("health status missing")
		}
		return { status: "ok" }
	},
}

/** Liveness probe via the same-origin proxy (no API key required upstream). */
export const getHealth = (signal?: AbortSignal): Promise<{ status: "ok" }> =>
	request("/healthz", { schema: healthSchema, signal })

export const createPayment = (
	input: CreatePaymentRequest,
	idempotencyKey: string,
	signal?: AbortSignal,
): Promise<Payment> =>
	request("/v1/payments", {
		method: "POST",
		body: input,
		schema: PaymentSchema,
		idempotencyKey,
		signal,
	})

export const listPayments = (
	signal?: AbortSignal,
): Promise<PaymentListResponse> =>
	request("/v1/payments", { schema: PaymentListResponseSchema, signal })

export const getPayment = (
	paymentId: string,
	signal?: AbortSignal,
): Promise<PaymentDetail> =>
	request(`/v1/payments/${encodeURIComponent(paymentId)}`, {
		schema: PaymentDetailSchema,
		signal,
	})

export const fundPayment = (
	paymentId: string,
	idempotencyKey: string,
	signal?: AbortSignal,
): Promise<Payment> =>
	request(`/v1/payments/${encodeURIComponent(paymentId)}/fund`, {
		method: "POST",
		body: {},
		schema: PaymentSchema,
		idempotencyKey,
		signal,
	})

/** Session-only API key row (secret never returned after create). */
export interface ApiKeyRow {
	id: string
	prefix: string
	label: string | null
	createdAt: string
	revokedAt: string | null
}

export type CreatedApiKey = ApiKeyRow & { key: string }

const parseApiKeyRow = (item: unknown): ApiKeyRow => {
	if (
		!isRecord(item) ||
		typeof item.id !== "string" ||
		typeof item.prefix !== "string" ||
		!(typeof item.label === "string" || item.label === null) ||
		typeof item.createdAt !== "string" ||
		!(typeof item.revokedAt === "string" || item.revokedAt === null)
	) {
		throw new Error("api key row invalid")
	}
	return {
		id: item.id,
		prefix: item.prefix,
		label: item.label,
		createdAt: item.createdAt,
		revokedAt: item.revokedAt,
	}
}

const apiKeyListSchema: Parser<{ keys: ApiKeyRow[] }> = {
	parse: (value) => {
		if (!isRecord(value) || !Array.isArray(value.keys)) {
			throw new Error("api keys missing")
		}
		return { keys: value.keys.map(parseApiKeyRow) }
	},
}

const createdApiKeySchema: Parser<CreatedApiKey> = {
	parse: (value) => {
		const row = parseApiKeyRow(value)
		if (!isRecord(value) || typeof value.key !== "string" || !value.key) {
			throw new Error("created api key missing secret")
		}
		return { ...row, key: value.key }
	},
}

const apiKeyRowSchema: Parser<ApiKeyRow> = {
	parse: parseApiKeyRow,
}

/** Session cookie required — Bearer keys cannot list or mint org keys. */
export const listApiKeys = (
	signal?: AbortSignal,
): Promise<{ keys: ApiKeyRow[] }> =>
	request("/v1/api-keys", { schema: apiKeyListSchema, signal })

export const createApiKey = (
	input: { label?: string } = {},
	signal?: AbortSignal,
): Promise<CreatedApiKey> =>
	request("/v1/api-keys", {
		method: "POST",
		body: input.label?.trim() ? { label: input.label.trim() } : {},
		schema: createdApiKeySchema,
		idempotencyKey: newIdempotencyKey("api-key"),
		signal,
	})

export const startBlindpayOnboarding = (signal?: AbortSignal) =>
	request("/v1/blindpay/onboarding", {
		method: "POST",
		body: {},
		schema: BlindPayOnboardingResponseSchema,
		idempotencyKey: newIdempotencyKey("blindpay-onboarding"),
		signal,
	})

export const saveBlindpayTos = (tosId: string, signal?: AbortSignal) =>
	request("/v1/blindpay/onboarding/tos", {
		method: "POST",
		body: { tosId },
		schema: BlindPayOnboardingResponseSchema,
		idempotencyKey: newIdempotencyKey("blindpay-tos"),
		signal,
	})

export const submitBlindpayKyc = (body: unknown, signal?: AbortSignal) =>
	request("/v1/blindpay/onboarding/kyc", {
		method: "POST",
		body: BlindPayKycBodySchema.parse(body),
		schema: BlindPayOnboardingResponseSchema,
		idempotencyKey: newIdempotencyKey("blindpay-kyc"),
		signal,
	})

const uploadedFileSchema: Parser<{ fileUrl: string }> = {
	parse(value) {
		const url =
			value && typeof value === "object" && "fileUrl" in value
				? (value as { fileUrl: unknown }).fileUrl
				: null
		if (typeof url !== "string" || !url.startsWith("https://"))
			throw new Error("upload response invalid")
		return { fileUrl: url }
	},
}

/** CCR-46: one ID document or selfie, streamed to BlindPay; FlexiPay keeps no copy. */
export const uploadBlindpayKycFile = (file: Blob, signal?: AbortSignal) =>
	request("/v1/blindpay/onboarding/upload", {
		method: "POST",
		file,
		schema: uploadedFileSchema,
		signal,
	})

export const requestBlindpayDelegation = (
	paymentId: string,
	ownerAddress: string,
	signal?: AbortSignal,
) =>
	request(`/v1/payments/${encodeURIComponent(paymentId)}/blindpay/delegation`, {
		method: "POST",
		body: { ownerAddress },
		schema: BlindPayDelegationResponseSchema,
		idempotencyKey: newIdempotencyKey("blindpay-delegation"),
		signal,
	})

export const confirmBlindpayPayout = (
	paymentId: string,
	signature: string,
	signal?: AbortSignal,
) =>
	request(`/v1/payments/${encodeURIComponent(paymentId)}/blindpay/confirm`, {
		method: "POST",
		body: { signature },
		schema: BlindPayConfirmResponseSchema,
		idempotencyKey: newIdempotencyKey("blindpay-confirm"),
		signal,
	})

/** CCR-51: Due's funding address and exact USDC amount, once the wallet is set up. */
export const getDueFunding = (paymentId: string, signal?: AbortSignal) =>
	request(`/v1/payments/${encodeURIComponent(paymentId)}/due/funding`, {
		schema: DueFundingResponseSchema,
		signal,
	})

/** CCR-51: create the Due transfer for this wallet (once) and return where to pay. */
export const prepareDueFunding = (
	paymentId: string,
	walletAddress: string,
	signal?: AbortSignal,
) =>
	request(`/v1/payments/${encodeURIComponent(paymentId)}/due/funding`, {
		method: "POST",
		body: { walletAddress },
		schema: DueFundingResponseSchema,
		idempotencyKey: newIdempotencyKey("due-funding"),
		signal,
	})

export type DueConfirmResult =
	| (ReturnType<typeof DueConfirmResponseSchema.parse> & { status: "verified" })
	| ReturnType<typeof SolanaConfirmPendingResponseSchema.parse>

const dueConfirmParser: Parser<DueConfirmResult> = {
	parse: (value) =>
		isRecord(value) && value.status === "pending"
			? SolanaConfirmPendingResponseSchema.parse(value)
			: {
					...DueConfirmResponseSchema.parse(value),
					status: "verified" as const,
				},
}

/** CCR-51: verify the sender's USDC transfer to Due. `pending` means Solana has not confirmed it yet. */
export const confirmDueFunding = (
	paymentId: string,
	signature: string,
	signal?: AbortSignal,
) =>
	request(`/v1/payments/${encodeURIComponent(paymentId)}/due/confirm`, {
		method: "POST",
		body: { signature },
		schema: dueConfirmParser,
		idempotencyKey: newIdempotencyKey("due-confirm"),
		signal,
	})

/** CCR-49: Jupiter swap (tGBP → USDC) for the sender's own wallet before a BlindPay payout. */
export const requestSolanaSwap = (
	paymentId: string,
	walletAddress: string,
	signal?: AbortSignal,
) =>
	request(`/v1/payments/${encodeURIComponent(paymentId)}/solana-swap`, {
		method: "POST",
		body: { walletAddress, inputAsset: "TGBP" },
		schema: SolanaSwapResponseSchema,
		idempotencyKey: newIdempotencyKey("solana-swap"),
		signal,
	})

export const confirmSolanaSwap = (
	paymentId: string,
	walletAddress: string,
	signature: string,
	signal?: AbortSignal,
) =>
	request(`/v1/payments/${encodeURIComponent(paymentId)}/solana-swap/confirm`, {
		method: "POST",
		body: { walletAddress, signature },
		schema: SolanaSwapConfirmResponseSchema,
		idempotencyKey: newIdempotencyKey("solana-swap-confirm"),
		signal,
	})

export const revokeApiKey = (
	id: string,
	signal?: AbortSignal,
): Promise<ApiKeyRow> =>
	request(`/v1/api-keys/${encodeURIComponent(id)}/revoke`, {
		method: "POST",
		body: {},
		schema: apiKeyRowSchema,
		idempotencyKey: newIdempotencyKey("api-key-revoke"),
		signal,
	})
