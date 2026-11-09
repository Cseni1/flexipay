import {
	CURRENCY_DECIMALS,
	ProviderError,
	money,
	toMinor,
	type EndpointRef,
	type LegExecution,
	type LegQuote,
	type LegQuoteRequest,
	type PayoutFieldRequirements,
	type Provider,
	type ProviderAdapter,
	type ProviderCapabilities,
	type ProviderErrorCode,
	type ProviderLegState,
} from "@flexipay/domain"
import { jsonRequest, type FetchLike, type HttpResult } from "./http.ts"

// Due off-ramp adapter (CCR-50). Due (due.network) converts a stablecoin (or a GBP bank pay-in) to
// local currency and pays the bank in one transfer, so like BlindPay and Tazapay it serves the
// convert + payout pair:
// - convert: priced from Due's transfer quote (POST /v1/transfers/quote) for the exact input;
//   executing it records the step, because the conversion happens inside the payout transfer.
// - payout: creates/reuses a Due recipient for the endpoint, takes a receive-amount quote for the
//   exact local amount and creates the transfer (POST /v1/transfers).
// Source: USDC goes in on Due's Solana rail ("solana-local" in the sandbox, "solana" in
// production); GBP and tGBP map to a GBP Faster Payments pay-in ("fp"), as Tazapay maps them to its
// GBP holding balance. Funding the transfer (sending the USDC to Due's funding address, or paying
// the GBP deposit details) is outside this adapter: `fundingInstructions()` returns where to pay.
// An unfunded transfer stays `awaiting_funds` (leg processing) and Due expires it after 2 hours.
// The production base URL is refused unless FP_DUE_LIVE_APPROVED=1 (written approval only).

export const DUE_SANDBOX_BASE_URL = "https://api.sandbox.due.network"
export const DUE_PRODUCTION_BASE_URL = "https://api.due.network"
const HEALTH_TTL_MS = 60_000
const CHANNELS_TTL_MS = 10 * 60_000
const RECIPIENT_REF = "due_recipient_id"
const CONVERT_REF = "due-convert:"
/** Short reference shown to the recipient's bank where the rail allows a memo. */
const MEMO = "FlexiPay"

/** Due transfer statuses (transfer-flow guide) -> FlexiPay leg status. */
const TRANSFER_STATUS: Record<string, ProviderLegState["status"]> = {
	awaiting_funds: "processing",
	funds_received: "processing",
	approved: "processing",
	manual_review: "processing",
	action_required: "processing",
	payment_submitted: "processing",
	payment_processed: "succeeded",
	failed: "failed",
	canceled: "failed",
	refund_submitted: "failed",
	refund_processed: "failed",
}

/** Withdrawal rail per payout currency when Due offers more than one (bank rails, no SWIFT). */
const PREFERRED_RAIL: Record<string, string> = {
	BRL: "brl_pix",
	MXN: "spei",
	COP: "cop_local",
	INR: "inr_upi",
	NGN: "ngn_local",
	PHP: "php_local",
	GBP: "fp",
	EUR: "sepa",
	USD: "ach",
}

/** Due recipient schema field -> CCR-17/CCR-34 endpoint detail key. */
const DETAIL_KEYS: Record<string, string> = {
	accountNumber: "accountNumber",
	pixKey: "pixKey",
	clabe: "clabe",
	IBAN: "iban",
	swiftCode: "swiftCode",
	bankName: "bankName",
	sortCode: "bankCode",
	routingNumber: "bankCode",
	financialInstitutionId: "bankCode",
	branchNumber: "branchCode",
	nin: "documentId",
	idNumber: "documentId",
	idType: "documentType",
	bankAccountType: "accountType",
	email: "email",
}

/** Due fields FlexiPay fills from the recipient itself (name and kind), never asked for. */
const NAME_FIELDS = new Set(["name", "beneficiaryName", "accountName"])

/** Due address sub-field -> CCR-43 local field. */
const ADDRESS_FIELDS: Record<string, string> = {
	street_line_1: "address.line1",
	street_line_2: "address.line2",
	city: "address.city",
	postal_code: "address.postal_code",
	state: "address.state",
	country: "address.country",
}

/** Colombian account types: FlexiPay's checking/savings words -> Due codes. */
const CO_ACCOUNT_TYPES: Record<string, string> = {
	checking: "cc",
	savings: "ch",
}

interface DueSource {
	rail: string
	currency: string
}

interface DueChannel {
	rail: string
	currency: string
	schemas: string[]
	memo: { min: number; max: number } | null
	purposeCodes: Record<string, string[]>
}

interface SchemaField {
	key: string
	required: boolean
	requiredIf?: string
	excludedUnless?: string
	oneOf?: string[]
	fields?: SchemaField[]
}

export interface DueOptions {
	apiKey: string
	/** Sent as Due-Account-Id; without it Due answers 401. */
	accountId: string
	liveApproved: boolean
	/** Due wallet id or address registered as the USDC sender; Due matches funding to it. */
	senderWallet?: string
	/** Due source rail for USDC; defaults to "solana-local" (sandbox) or "solana" (production). */
	solanaRail?: string
	/** Purpose code used when a channel requires one and offers it; defaults to OTHER. */
	purposeCode?: string
	baseUrl?: string
	fetch?: FetchLike
	now?: () => number
}

function objectOf(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function decimalsOf(currency: string): number {
	const d = CURRENCY_DECIMALS[currency]
	if (d === undefined)
		throw new ProviderError("unsupported", `Due: unknown currency ${currency}`)
	return d
}

/** "546.29" -> minor units at `decimals`, rounding down; null when it is not a decimal. */
export function decimalToMinor(
	value: unknown,
	decimals: number,
): bigint | null {
	const text =
		typeof value === "number" && Number.isFinite(value)
			? value.toFixed(Math.max(decimals, 0) + 2)
			: typeof value === "string"
				? value.trim()
				: ""
	const m = /^(\d+)(?:\.(\d*))?$/.exec(text)
	if (!m) return null
	const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0")
	return BigInt(m[1]!) * 10n ** BigInt(decimals) + (frac ? BigInt(frac) : 0n)
}

/** Minor units -> decimal string with at most `maxDecimals` places, rounding down. */
export function minorToDecimal(
	minor: bigint,
	decimals: number,
	maxDecimals = decimals,
): string {
	const keep = Math.min(decimals, maxDecimals)
	const scaled = minor / 10n ** BigInt(decimals - keep)
	if (keep === 0) return scaled.toString()
	const unit = 10n ** BigInt(keep)
	const frac = (scaled % unit).toString().padStart(keep, "0").replace(/0+$/, "")
	return frac ? `${scaled / unit}.${frac}` : `${scaled / unit}`
}

/** Due's fxRate is "source per 1 destination"; FlexiPay wants "out per 1 in", 4 places. */
function rateText(dueRate: number): string {
	const scaled = BigInt(Math.round((1 / dueRate) * 10_000))
	return `${scaled / 10_000n}.${(scaled % 10_000n).toString().padStart(4, "0")}`
}

/** "accountType=individual" holds for this recipient kind. */
function conditionHolds(
	cond: string | undefined,
	accountType: string,
): boolean {
	if (!cond) return true
	const [field, expected] = cond.split("=")
	return field === "accountType" ? expected === accountType : false
}

function splitName(full: string): { first: string; last: string } {
	const parts = full.trim().split(/\s+/)
	if (parts.length < 2) return { first: parts[0] ?? "", last: parts[0] ?? "" }
	return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1]! }
}

function parseFields(value: unknown): SchemaField[] {
	if (!Array.isArray(value)) return []
	const fields: SchemaField[] = []
	for (const item of value) {
		const f = objectOf(item)
		if (!f || typeof f.key !== "string") continue
		fields.push({
			key: f.key,
			required: f.required === true,
			...(typeof f.requiredIf === "string" ? { requiredIf: f.requiredIf } : {}),
			...(typeof f.excludedUnless === "string"
				? { excludedUnless: f.excludedUnless }
				: {}),
			...(Array.isArray(f.oneOf)
				? {
						oneOf: f.oneOf.filter((v): v is string => typeof v === "string"),
					}
				: {}),
			...(Array.isArray(f.fields) ? { fields: parseFields(f.fields) } : {}),
		})
	}
	return fields
}

export class DueAdapter implements ProviderAdapter {
	readonly id: string
	private readonly row: Provider
	private readonly opts: DueOptions
	private readonly fetchImpl: FetchLike
	private readonly now: () => number
	private readonly baseUrl: string
	private readonly solanaRail: string
	private readonly issued = new Map<string, string>()
	/** endpointId -> Due recipient id, so a second leg does not create another. */
	private readonly recipients = new Map<string, string>()
	/** paymentId -> Due source, set when the convert step runs. */
	private readonly sourceByPayment = new Map<string, DueSource>()
	private channelsCache: { at: number; list: DueChannel[] } | null = null
	private schemasCache: Map<string, SchemaField[]> | null = null
	private healthCache: { at: number; value: "up" | "down" } | null = null

	constructor(row: Provider, opts: DueOptions) {
		this.id = row.id
		this.row = row
		this.opts = opts
		this.fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
		this.now = opts.now ?? (() => Date.now())
		this.baseUrl = (opts.baseUrl ?? DUE_SANDBOX_BASE_URL).replace(/\/$/, "")
		this.solanaRail =
			opts.solanaRail ??
			(this.baseUrl === DUE_PRODUCTION_BASE_URL ? "solana" : "solana-local")
	}

	capabilities(): ProviderCapabilities {
		return {
			providerId: this.id,
			countries: this.row.countries,
			currencies: this.row.currencies,
			endpointTypes: this.row.endpointTypes,
			legKinds: this.row.legKinds,
			limits: this.row.limits,
			simulated: this.row.simulated,
		}
	}

	/** Sandbox vs live, for the operator partner-status route. */
	mode(): "sandbox" | "live" {
		return this.baseUrl === DUE_PRODUCTION_BASE_URL ? "live" : "sandbox"
	}

	async quote(req: LegQuoteRequest): Promise<LegQuote> {
		this.assertEnvironment()
		this.assertServes(req.kind)
		if (req.kind === "convert") return this.quoteConvert(req)
		// payout: the conversion and Due's fee are on the convert leg; nothing more is charged.
		if (req.amountIn.currency !== req.outCurrency) {
			throw new ProviderError(
				"currency_mismatch",
				"Due payout must be in the local currency; the convert leg runs first",
			)
		}
		this.assertPayoutCurrency(req.outCurrency)
		return {
			providerId: this.id,
			fee: money(0n, req.outCurrency),
			fxRate: null,
			amountOut: req.amountIn,
			estimatedTimeSeconds: this.row.estimatedTimeSeconds,
			simulated: this.row.simulated,
		}
	}

	private async quoteConvert(req: LegQuoteRequest): Promise<LegQuote> {
		const source = this.sourceFor(req.amountIn.currency)
		this.assertPayoutCurrency(req.outCurrency)
		const channel = await this.channelFor(req.outCurrency)
		const inDecimals = decimalsOf(req.amountIn.currency)
		const inMinor = toMinor(req.amountIn)
		// Due takes USDC with 6 decimals (the Solana mint) and fiat with 2.
		const amount = minorToDecimal(
			inMinor,
			inDecimals,
			source.currency === "USDC" ? 6 : 2,
		)
		if (amount === "0")
			throw new ProviderError("below_min", "Amount too small for Due")
		const data = this.ok(
			await this.call("POST", "/v1/transfers/quote", {
				source: { ...source, amount },
				destination: {
					rail: channel.rail,
					currency: req.outCurrency,
					amount: "0",
				},
			}),
			"quote",
		)
		const { outMinor, feeMinor, rate } = this.readQuote(
			data,
			req.amountIn.currency,
			req.outCurrency,
		)
		return {
			providerId: this.id,
			fee: money(
				feeMinor < inMinor ? feeMinor : inMinor,
				req.amountIn.currency,
			),
			fxRate: rate,
			amountOut: money(outMinor, req.outCurrency),
			estimatedTimeSeconds: this.row.estimatedTimeSeconds,
			simulated: this.row.simulated,
		}
	}

	/** Reads amount, total fee (source side, in the input currency) and rate from a Due quote. */
	private readQuote(
		data: Record<string, unknown>,
		inCurrency: string,
		outCurrency: string,
	): {
		outMinor: bigint
		feeMinor: bigint
		rate: string
		token: string | null
	} {
		const src = objectOf(data.source)
		const dst = objectOf(data.destination)
		const fxRate = data.fxRate
		const outMinor = decimalToMinor(dst?.amount, decimalsOf(outCurrency))
		const feeMinor = decimalToMinor(
			src?.totalFee ?? src?.fee ?? "0",
			decimalsOf(inCurrency),
		)
		if (
			outMinor === null ||
			feeMinor === null ||
			typeof fxRate !== "number" ||
			!(fxRate > 0)
		)
			throw new Error("Due quote returned no amount, fee or rate")
		if (outMinor <= 0n)
			throw new ProviderError(
				"fee_exceeds_amount",
				"Due fee exceeds the amount",
			)
		return {
			outMinor,
			feeMinor,
			rate: rateText(fxRate),
			token: typeof data.token === "string" ? data.token : null,
		}
	}

	async execute(leg: LegExecution): Promise<{
		externalRef: string
		partnerRefs?: Record<string, string>
	}> {
		this.assertEnvironment()
		this.assertServes(leg.kind)
		const key = `${leg.legId}:${leg.attempt}`
		if (leg.kind === "convert") {
			const source = this.sourceFor(leg.amountIn.currency)
			this.sourceByPayment.set(leg.paymentId, source)
			return { externalRef: `${CONVERT_REF}${source.currency}:${key}` }
		}
		if (leg.amountIn.currency !== leg.outCurrency) {
			throw new ProviderError(
				"currency_mismatch",
				"Due payout must be in the local currency; the convert leg runs first",
			)
		}
		this.assertPayoutCurrency(leg.amountIn.currency)
		const known = this.issued.get(key)
		if (known) return { externalRef: known }

		const channel = await this.channelFor(leg.amountIn.currency)
		const recipient = await this.recipientFor(leg.endpoint, channel)
		const source =
			this.sourceByPayment.get(leg.paymentId) ?? this.sourceFor("USDC")
		// Receive-amount quote: the recipient gets exactly the quoted local amount.
		const quote = this.ok(
			await this.call("POST", "/v1/transfers/quote", {
				source: { ...source, amount: "0" },
				destination: {
					rail: channel.rail,
					currency: leg.amountIn.currency,
					amount: minorToDecimal(
						toMinor(leg.amountIn),
						decimalsOf(leg.amountIn.currency),
					),
				},
			}),
			"payout quote",
		)
		if (typeof quote.token !== "string")
			throw new Error("Due payout quote returned no token")
		const kind =
			leg.endpoint?.recipientKind === "company" ? "business" : "individual"
		const purpose = this.purposeFor(channel, kind)
		const memo = this.memoFor(channel)
		const transfer = this.ok(
			await this.call("POST", "/v1/transfers", {
				quote: quote.token,
				recipient: recipient.id,
				...(source.currency === "USDC" && this.opts.senderWallet
					? { sender: this.opts.senderWallet }
					: {}),
				...(memo ? { memo } : {}),
				...(purpose ? { purposeCode: purpose } : {}),
			}),
			"transfer",
		)
		if (typeof transfer.id !== "string")
			throw new Error("Due create transfer returned no id")
		this.issued.set(key, transfer.id)
		return {
			externalRef: transfer.id,
			...(recipient.created
				? { partnerRefs: { [RECIPIENT_REF]: recipient.id } }
				: {}),
		}
	}

	/**
	 * Where to pay a transfer's source funds: Due's funding address for a USDC transfer
	 * (POST /v1/transfers/{id}/funding_address), else the deposit details on the transfer.
	 * The amount must be sent exactly, in one transaction, before `expiresAt`.
	 */
	async fundingInstructions(transferId: string): Promise<{
		amount: string
		currency: string
		rail: string
		details: Record<string, unknown> | null
		expiresAt: string | null
	}> {
		this.assertEnvironment()
		const transfer = await this.readTransfer(transferId)
		const src = objectOf(transfer.source)
		const currency = typeof src?.currency === "string" ? src.currency : ""
		const rail = typeof src?.rail === "string" ? src.rail : ""
		let details = objectOf(objectOf(transfer.transferInstructions)?.details)
		if (currency === "USDC") {
			const funding = this.ok(
				await this.call(
					"POST",
					`/v1/transfers/${encodeURIComponent(transferId)}/funding_address`,
				),
				"funding address",
			)
			details = objectOf(funding.details)
		}
		return {
			amount: typeof src?.amount === "string" ? src.amount : "",
			currency,
			rail,
			details,
			expiresAt:
				typeof transfer.expiresAt === "string" ? transfer.expiresAt : null,
		}
	}

	/** CCR-32: reuse the recipient persisted on the endpoint, else create one from its details. */
	private async recipientFor(
		endpoint: EndpointRef | undefined,
		channel: DueChannel,
	): Promise<{ id: string; created: boolean }> {
		if (!endpoint) {
			throw new ProviderError(
				"unsupported",
				"Due payout needs the recipient's bank details",
			)
		}
		const known =
			endpoint.partnerRefs?.[RECIPIENT_REF] ??
			this.recipients.get(endpoint.endpointId)
		if (known) return { id: known, created: false }
		const id = await this.createRecipient(endpoint, channel)
		this.recipients.set(endpoint.endpointId, id)
		return { id, created: true }
	}

	private async createRecipient(
		endpoint: EndpointRef,
		channel: DueChannel,
	): Promise<string> {
		if (!endpoint.recipientName) {
			throw new ProviderError(
				"unsupported",
				`Due recipient for endpoint ${endpoint.endpointId} needs the recipient name`,
			)
		}
		const schema = channel.schemas[0]!
		const fields = (await this.schemaFields())?.get(schema)
		if (!fields) {
			throw new ProviderError(
				"unsupported",
				`Due has no recipient schema ${schema} for ${channel.currency}`,
			)
		}
		const accountType =
			endpoint.recipientKind === "company" ? "business" : "individual"
		const name = endpoint.details?.accountHolderName ?? endpoint.recipientName
		const split = splitName(endpoint.recipientName)
		const detail = (key: string) => endpoint.details?.[key]
		const details: Record<string, string> = { schema }
		const missing: string[] = []
		for (const field of fields) {
			if (!conditionHolds(field.excludedUnless, accountType)) continue
			const required =
				field.required ||
				(field.requiredIf !== undefined &&
					conditionHolds(field.requiredIf, accountType))
			let value: string | undefined
			if (field.key === "accountType") value = accountType
			else if (field.key === "firstName")
				value = detail("firstName") ?? split.first
			else if (field.key === "lastName")
				value = detail("lastName") ?? split.last
			else if (field.key === "companyName") value = endpoint.recipientName
			else if (NAME_FIELDS.has(field.key)) value = name
			else if (DETAIL_KEYS[field.key]) {
				value = detail(DETAIL_KEYS[field.key]!)
				if (value && field.key === "bankAccountType")
					value = CO_ACCOUNT_TYPES[value.toLowerCase()] ?? value
				if (value && field.key === "idType") value = value.toLowerCase()
			}
			if (value) details[field.key] = value
			else if (required)
				missing.push(
					DETAIL_KEYS[field.key]
						? `${DETAIL_KEYS[field.key]} (Due ${field.key})`
						: field.key,
				)
		}
		if (missing.length > 0) {
			throw new ProviderError(
				"unsupported",
				`Due recipient for endpoint ${endpoint.endpointId} is missing ${missing.join(", ")} (schema ${schema})`,
			)
		}
		const res = await this.call("POST", "/v1/recipients", {
			name: endpoint.recipientName,
			details,
			isExternal: true,
		})
		// Due deduplicates recipients by account details (sandbox answers 409; the guide says 400).
		// Reuse the existing one, e.g. when an earlier process created it before the id was saved.
		if (objectOf(res.json)?.code === "err_recipient_already_exists") {
			const existing = await this.findRecipient(details)
			if (existing) return existing
		}
		const data = this.ok(res, "recipient")
		if (typeof data.id !== "string" || data.id.length === 0)
			throw new Error("Due create recipient returned no id")
		return data.id
	}

	/** First page of GET /v1/recipients: the active one whose details match exactly. */
	private async findRecipient(
		details: Record<string, string>,
	): Promise<string | null> {
		const res = await this.call("GET", "/v1/recipients")
		const items = objectOf(res.json)?.items
		if (res.status !== 200 || !Array.isArray(items)) return null
		for (const item of items) {
			const r = objectOf(item)
			const got = objectOf(r?.details)
			if (!r || typeof r.id !== "string" || !got || r.isActive === false)
				continue
			if (Object.entries(details).every(([k, v]) => got[k] === v)) return r.id
		}
		return null
	}

	/**
	 * CCR-43: FlexiPay detail keys and local fields Due needs for a payout in this currency,
	 * from the channel's recipient schema (GET /v1/channels + GET /v1/schemas). Fields Due
	 * fills from the recipient's name and kind are not listed.
	 */
	async payoutRequirements(
		_country: string,
		currency: string,
	): Promise<PayoutFieldRequirements | null> {
		this.assertEnvironment()
		if (!this.payoutCurrencies().includes(currency)) return null
		const channel = await this.channelFor(currency)
		const fields = (await this.schemaFields())?.get(channel.schemas[0]!)
		if (!fields) return null
		const detailKeys: string[] = []
		const localFields: string[] = []
		for (const field of fields) {
			// Conditional detail fields (e.g. Colombian idType for individuals) are listed too:
			// most recipients are individuals, and the payout leg checks the real kind.
			if (!field.required && !(field.requiredIf && DETAIL_KEYS[field.key]))
				continue
			if (
				field.key === "accountType" ||
				field.key === "companyName" ||
				field.key === "firstName" ||
				field.key === "lastName" ||
				NAME_FIELDS.has(field.key)
			)
				continue
			if (field.fields && field.fields.length > 0) {
				for (const sub of field.fields) {
					if (sub.required)
						localFields.push(
							ADDRESS_FIELDS[sub.key] ?? `${field.key}.${sub.key}`,
						)
				}
				continue
			}
			detailKeys.push(DETAIL_KEYS[field.key] ?? field.key)
		}
		return {
			detailKeys: [...new Set(detailKeys)],
			localFields: [...new Set(localFields)],
		}
	}

	async status(externalRef: string): Promise<ProviderLegState> {
		if (externalRef.startsWith(CONVERT_REF))
			return { status: "succeeded", externalRef }
		this.assertEnvironment()
		const data = await this.readTransfer(externalRef)
		const raw = typeof data.status === "string" ? data.status : ""
		const status = TRANSFER_STATUS[raw] ?? "processing"
		if (status === "failed") {
			return {
				status,
				externalRef,
				error: { code: "provider_down", message: `Due transfer ${raw}` },
			}
		}
		return { status, externalRef }
	}

	private async readTransfer(id: string): Promise<Record<string, unknown>> {
		const res = await this.call(
			"GET",
			`/v1/transfers/${encodeURIComponent(id)}`,
		)
		if (res.status === 404)
			throw new ProviderError("unknown_reference", `Due has no transfer ${id}`)
		return this.ok(res, "transfer status")
	}

	async reverse(externalRef: string): Promise<{ externalRef: string }> {
		// The convert step is only a record (the money converts inside the transfer), so undoing
		// it moves nothing. A Due payout cannot be pulled back through the API.
		if (externalRef.startsWith(CONVERT_REF))
			return { externalRef: `${externalRef}:reversed` }
		throw new ProviderError("not_reversible", "A Due payout cannot be reversed")
	}

	async health(): Promise<"up" | "down"> {
		const t = this.now()
		if (this.healthCache && t - this.healthCache.at < HEALTH_TTL_MS)
			return this.healthCache.value
		let value: "up" | "down" = "down"
		if (this.baseUrl !== DUE_PRODUCTION_BASE_URL || this.opts.liveApproved) {
			try {
				const channels = await this.channels(true)
				value = this.payoutCurrencies().some((c) =>
					channels.some((ch) => ch.currency === c),
				)
					? "up"
					: "down"
			} catch {
				value = "down"
			}
		}
		this.healthCache = { at: t, value }
		return value
	}

	/** GET /v1/channels, withdrawal channels only, cached for 10 minutes. */
	private async channels(force = false): Promise<DueChannel[]> {
		const t = this.now()
		if (
			!force &&
			this.channelsCache &&
			t - this.channelsCache.at < CHANNELS_TTL_MS
		)
			return this.channelsCache.list
		const res = await this.call("GET", "/v1/channels")
		const raw = Array.isArray(res.json)
			? res.json
			: objectOf(res.json)?.channels
		if (res.status < 200 || res.status >= 300 || !Array.isArray(raw))
			this.ok(res, "channels")
		const list: DueChannel[] = []
		for (const item of raw as unknown[]) {
			const c = objectOf(item)
			if (!c || c.type !== "withdrawal" || typeof c.rail !== "string") continue
			const currency = c.currencyCode ?? c.currency_code
			const settings = objectOf(c.railSettings)
			const schemas = Array.isArray(settings?.schemas)
				? settings.schemas.filter((s): s is string => typeof s === "string")
				: []
			if (typeof currency !== "string" || schemas.length === 0) continue
			const memo = objectOf(settings?.memoConfig)
			const purposeCodes: Record<string, string[]> = {}
			for (const [k, v] of Object.entries(objectOf(c.purposeCodes) ?? {})) {
				if (Array.isArray(v))
					purposeCodes[k] = v.filter((s): s is string => typeof s === "string")
			}
			list.push({
				rail: c.rail,
				currency,
				schemas,
				memo: memo
					? {
							min:
								typeof memo.minCharacters === "number" ? memo.minCharacters : 0,
							max:
								typeof memo.maxCharacters === "number" ? memo.maxCharacters : 0,
						}
					: null,
				purposeCodes,
			})
		}
		this.channelsCache = { at: t, list }
		return list
	}

	private async channelFor(currency: string): Promise<DueChannel> {
		const list = (await this.channels()).filter((c) => c.currency === currency)
		const preferred = PREFERRED_RAIL[currency]
		const channel =
			list.find((c) => c.rail === preferred) ??
			list.find(
				(c) => c.schemas[0]!.startsWith("bank_") && c.rail !== "swift",
			) ??
			list.find((c) => c.schemas[0]!.startsWith("bank_"))
		if (!channel) {
			throw new ProviderError(
				"unsupported",
				`Due has no bank withdrawal channel for ${currency}`,
			)
		}
		return channel
	}

	/** GET /v1/schemas, cached for the life of the adapter. */
	private async schemaFields(): Promise<Map<string, SchemaField[]>> {
		if (this.schemasCache) return this.schemasCache
		const res = await this.call("GET", "/v1/schemas")
		const raw = Array.isArray(res.json) ? res.json : objectOf(res.json)?.schemas
		if (res.status < 200 || res.status >= 300 || !Array.isArray(raw))
			this.ok(res, "schemas")
		const map = new Map<string, SchemaField[]>()
		for (const item of raw as unknown[]) {
			const s = objectOf(item)
			if (s && typeof s.id === "string") map.set(s.id, parseFields(s.fields))
		}
		this.schemasCache = map
		return map
	}

	private purposeFor(channel: DueChannel, kind: string): string | null {
		const codes = [
			...(channel.purposeCodes.any ?? []),
			...(channel.purposeCodes[kind] ?? []),
		]
		if (codes.length === 0) return null
		const wanted = this.opts.purposeCode ?? "OTHER"
		if (codes.includes(wanted)) return wanted
		return codes.includes("OTHER") ? "OTHER" : codes[0]!
	}

	private memoFor(channel: DueChannel): string | null {
		if (!channel.memo || channel.memo.max <= 0) return null
		if (MEMO.length < channel.memo.min) return null
		return MEMO.slice(0, channel.memo.max)
	}

	/** Convert input -> Due source rail and currency. */
	private sourceFor(currency: string): DueSource {
		if (!this.row.currencies.includes(currency)) {
			throw new ProviderError(
				"unsupported",
				`Due does not convert from ${currency}`,
			)
		}
		if (currency === "USDC") return { rail: this.solanaRail, currency: "USDC" }
		if (currency === "GBP" || currency === "TGBP")
			return { rail: "fp", currency: "GBP" }
		throw new ProviderError(
			"unsupported",
			`Due does not convert from ${currency}`,
		)
	}

	/** Row currencies Due pays out: every fiat currency on the row (not the inputs). */
	private payoutCurrencies(): string[] {
		return this.row.currencies.filter(
			(c) => c !== "USDC" && c !== "TGBP" && c !== "GBP",
		)
	}

	private assertPayoutCurrency(currency: string) {
		if (!this.payoutCurrencies().includes(currency)) {
			throw new ProviderError("unsupported", `Due does not pay out ${currency}`)
		}
	}

	private assertEnvironment() {
		if (this.baseUrl === DUE_PRODUCTION_BASE_URL && !this.opts.liveApproved) {
			throw new ProviderError(
				"unsupported",
				"Due production is not approved for real money",
			)
		}
	}

	private assertServes(kind: string) {
		if (!this.row.legKinds.includes(kind as Provider["legKinds"][number])) {
			throw new ProviderError("unsupported", `Due does not serve ${kind}`)
		}
	}

	private call(method: "GET" | "POST", path: string, body?: unknown) {
		return jsonRequest(this.fetchImpl, {
			method,
			url: `${this.baseUrl}${path}`,
			headers: {
				Authorization: `Bearer ${this.opts.apiKey}`,
				"Due-Account-Id": this.opts.accountId,
			},
			body,
		})
	}

	/**
	 * Due errors are `{ message, code, httpCode, data }`. A 4xx is Due refusing the request, so
	 * nothing was created or moved: a ProviderError lets the orchestrator fail the leg cleanly
	 * (CCR-36). 5xx and network errors stay plain errors because the outcome is unknown.
	 */
	private ok(res: HttpResult, what: string): Record<string, unknown> {
		const json = objectOf(res.json)
		if (res.status >= 200 && res.status < 300 && json) return json
		const code = typeof json?.code === "string" ? json.code : ""
		const detail =
			typeof json?.message === "string" ? json.message : "no detail"
		const message = `Due ${what} failed (HTTP ${res.status}${code ? ` ${code}` : ""}: ${detail.slice(0, 200)})`
		if (res.status >= 400 && res.status < 500) {
			const mapped: ProviderErrorCode =
				code === "err_quote_limit_below_fee"
					? "fee_exceeds_amount"
					: code === "err_quote_limit_exceeded"
						? "above_max"
						: "unsupported"
			throw new ProviderError(mapped, message)
		}
		throw new Error(message)
	}
}
