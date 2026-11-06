import {
	CURRENCY_DECIMALS,
	ProviderError,
	money,
	toMinor,
	type LegExecution,
	type LegQuote,
	type LegQuoteRequest,
	type Provider,
	type ProviderAdapter,
	type EndpointRef,
	type ProviderCapabilities,
	type ProviderLegState,
} from "@flexipay/domain"
import { jsonRequest, type FetchLike, type HttpResult } from "./http.ts"

// Tazapay off-ramp adapter (CCR-30). Tazapay holds a GBP or USD balance and, in one payout call,
// converts it to local currency and pays the bank. It cannot hold the payout currency itself
// (sandbox error 20168 for PHP), so like BlindPay it serves the convert + payout pair:
// - convert: priced from Tazapay's payout quote for the exact holding amount (the quote's payout
//   amount is already net of Tazapay's fee); executing it records the step, because the conversion
//   happens inside the payout.
// - payout: pays the quoted local amount from the holding balance.
// The convert input maps to a holding currency: GBP and tGBP to GBP, USD and USDC to USD
// (FlexiPay funds the balance by off-ramping the stablecoin; that funding is outside this adapter).
// The production base URL is refused unless FP_TAZAPAY_LIVE_APPROVED=1 (written approval only).

const SANDBOX_BASE_URL = "https://service-sandbox.tazapay.com"
const PRODUCTION_BASE_URL = "https://service.tazapay.com"
const HEALTH_TTL_MS = 60_000
/** Documented Tazapay purpose code: "Payment for Services". */
const DEFAULT_PURPOSE_CODE = "PYR001"
/** Non-routable sandbox contact when the endpoint carries no recipient email. */
const DEFAULT_BENEFICIARY_EMAIL = "sandbox@flexipay.test"
const BENEFICIARY_REF = "tazapay_beneficiary_id"

/** Tazapay metadata bank field -> CCR-32 endpoint detail key. */
const BANK_FIELD_KEYS: Record<string, string> = {
	account_number: "accountNumber",
	account_holder_name: "accountHolderName",
	bank_name: "bankName",
	iban: "iban",
}

/** Tazapay metadata bank code -> CCR-32 endpoint detail key. */
const BANK_CODE_KEYS: Record<string, string> = {
	swift_code: "swiftCode",
	bic_code: "swiftCode",
	branch_code: "branchCode",
	bank_code: "bankCode",
	ifsc_code: "bankCode",
	aba_code: "bankCode",
	sort_code: "bankCode",
	bsb_code: "bankCode",
	cnaps: "bankCode",
}
/** Tazapay amounts are integers in hundredths of every currency (sandbox: 1000000 VND = 10,000 VND). */
const TAZAPAY_DECIMALS = 2
const CONVERT_REF = "tazapay-convert:"

/** Convert input currency -> Tazapay holding currency. */
const HOLDING: Record<string, string> = {
	GBP: "GBP",
	TGBP: "GBP",
	USD: "USD",
	USDC: "USD",
}

export interface TazapayOptions {
	apiKey: string
	apiSecret: string
	/** Sandbox beneficiary, used only on the sandbox URL when the endpoint has no bank details. */
	sandboxBeneficiaryId: string | null
	/** Contact email sent to Tazapay when creating a beneficiary; sandbox placeholder by default. */
	beneficiaryEmail?: string
	liveApproved: boolean
	/** Holding currency for a payout whose convert step this process did not see; default USD. */
	defaultHoldingCurrency?: string
	/** Tazapay purpose code (PYR001..PYR036); defaults to PYR001. */
	purposeCode?: string
	baseUrl?: string
	fetch?: FetchLike
	now?: () => number
}

/** Tazapay payout states; holds and funding states are still in flight. */
const PAYOUT_STATUS: Record<string, ProviderLegState["status"]> = {
	succeeded: "succeeded",
	processing: "processing",
	requires_funding: "processing",
	requires_confirmation: "processing",
	requires_action: "processing",
	requires_approval: "processing",
	approval_hold: "processing",
	initiator_bank_hold: "processing",
	compliance_hold: "processing",
	failed: "failed",
	cancelled: "failed",
	reversed: "failed",
}

function objectOf(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: null
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string")
		: []
}

function intOf(value: unknown): bigint {
	return typeof value === "number" && Number.isFinite(value)
		? BigInt(Math.floor(value))
		: 0n
}

function rescale(
	minor: bigint,
	fromDecimals: number,
	toDecimals: number,
): bigint {
	if (toDecimals >= fromDecimals)
		return minor * 10n ** BigInt(toDecimals - fromDecimals)
	return minor / 10n ** BigInt(fromDecimals - toDecimals)
}

function decimalsOf(currency: string): number {
	const d = CURRENCY_DECIMALS[currency]
	if (d === undefined)
		throw new ProviderError(
			"unsupported",
			`Tazapay: unknown currency ${currency}`,
		)
	return d
}

function rateText(rate: number): string {
	const scaled = BigInt(Math.round(rate * 10_000))
	return `${scaled / 10_000n}.${(scaled % 10_000n).toString().padStart(4, "0")}`
}

export class TazapayAdapter implements ProviderAdapter {
	readonly id: string
	private readonly row: Provider
	private readonly opts: TazapayOptions
	private readonly fetchImpl: FetchLike
	private readonly now: () => number
	private readonly baseUrl: string
	private readonly purposeCode: string
	private readonly issued = new Map<string, string>()
	/** endpointId -> Tazapay beneficiary id, so a second leg does not create another. */
	private readonly beneficiaries = new Map<string, string>()
	/** paymentId -> holding currency, set when the convert step runs. */
	private readonly holdingByPayment = new Map<string, string>()
	private healthCache: { at: number; value: "up" | "down" } | null = null

	constructor(row: Provider, opts: TazapayOptions) {
		this.id = row.id
		this.row = row
		this.opts = opts
		this.fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
		this.now = opts.now ?? (() => Date.now())
		this.baseUrl = opts.baseUrl ?? SANDBOX_BASE_URL
		this.purposeCode = opts.purposeCode ?? DEFAULT_PURPOSE_CODE
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

	async quote(req: LegQuoteRequest): Promise<LegQuote> {
		this.assertEnvironment()
		this.assertServes(req.kind)
		if (req.kind === "convert") return this.quoteConvert(req)
		// payout: the conversion and Tazapay's fee are on the convert leg; nothing more is charged.
		if (req.amountIn.currency !== req.outCurrency) {
			throw new ProviderError(
				"currency_mismatch",
				"Tazapay payout must be in the local currency; the convert leg runs first",
			)
		}
		this.assertCurrency(req.outCurrency)
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
		const holding = this.holdingFor(req.amountIn.currency)
		this.assertCurrency(req.outCurrency)
		const inMinor = toMinor(req.amountIn)
		const inDecimals = decimalsOf(req.amountIn.currency)
		const holdAmount = rescale(inMinor, inDecimals, TAZAPAY_DECIMALS)
		if (holdAmount <= 0n)
			throw new ProviderError("below_min", "Amount too small for Tazapay")
		const country = this.countryFor(req)
		const data = this.ok(
			await this.call("POST", "/v3/payout/quote", {
				payout_type: "local",
				holding_info: { currency: holding, amount: Number(holdAmount) },
				payout_info: { currency: req.outCurrency },
				destination_info: { currency: req.outCurrency, country },
			}),
			"payout quote",
		)
		const payoutInfo = objectOf(data.payout_info)
		const feeInfo = objectOf(data.fee_info)
		const rates = objectOf(data.exchange_rates)
		const rate = rates?.holding_to_payout
		if (
			!payoutInfo ||
			typeof payoutInfo.amount !== "number" ||
			!feeInfo ||
			typeof rate !== "number" ||
			rate <= 0
		)
			throw new Error("Tazapay payout quote returned no amount, fee or rate")
		const outMinor = rescale(
			intOf(payoutInfo.amount),
			TAZAPAY_DECIMALS,
			decimalsOf(req.outCurrency),
		)
		if (outMinor <= 0n)
			throw new ProviderError(
				"fee_exceeds_amount",
				"Tazapay fee exceeds the amount",
			)
		const feeHolding =
			intOf(objectOf(feeInfo.fixed)?.in_holding_currency) +
			intOf(objectOf(feeInfo.variable)?.in_holding_currency)
		const fee = rescale(feeHolding, TAZAPAY_DECIMALS, inDecimals)
		return {
			providerId: this.id,
			fee: money(fee < inMinor ? fee : inMinor, req.amountIn.currency),
			fxRate: rateText(rate),
			amountOut: money(outMinor, req.outCurrency),
			estimatedTimeSeconds: this.row.estimatedTimeSeconds,
			simulated: this.row.simulated,
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
			const holding = this.holdingFor(leg.amountIn.currency)
			this.holdingByPayment.set(leg.paymentId, holding)
			return { externalRef: `${CONVERT_REF}${holding}:${key}` }
		}
		if (leg.amountIn.currency !== leg.outCurrency) {
			throw new ProviderError(
				"currency_mismatch",
				"Tazapay payout must be in the local currency; the convert leg runs first",
			)
		}
		this.assertCurrency(leg.amountIn.currency)

		const known = this.issued.get(key)
		if (known) return { externalRef: known }

		const beneficiary = await this.beneficiaryFor(leg.endpoint)
		const holding =
			this.holdingByPayment.get(leg.paymentId) ??
			this.opts.defaultHoldingCurrency ??
			"USD"
		const reference = `flexipay-${key}`
		const amount = rescale(
			toMinor(leg.amountIn),
			decimalsOf(leg.amountIn.currency),
			TAZAPAY_DECIMALS,
		)
		const data = this.ok(
			await this.call(
				"POST",
				"/v3/payout",
				{
					amount: Number(amount),
					currency: leg.amountIn.currency,
					holding_currency: holding,
					type: "local",
					purpose: this.purposeCode,
					beneficiary: beneficiary.id,
					reference_id: reference,
					transaction_description: "FlexiPay payout",
				},
				reference,
			),
			"payout",
		)
		if (typeof data.id !== "string")
			throw new Error("Tazapay create payout returned no id")
		this.issued.set(key, data.id)
		return {
			externalRef: data.id,
			...(beneficiary.created
				? { partnerRefs: { [BENEFICIARY_REF]: beneficiary.id } }
				: {}),
		}
	}

	/**
	 * CCR-32: reuse the beneficiary persisted on the endpoint, else create one from the recipient's
	 * bank details. The sandbox fallback is allowed only on the sandbox URL and only when details
	 * are absent.
	 */
	private async beneficiaryFor(
		endpoint: EndpointRef | undefined,
	): Promise<{ id: string; created: boolean }> {
		if (!endpoint) {
			const fallback = this.sandboxFallback()
			if (fallback) return { id: fallback, created: false }
			throw new ProviderError(
				"unsupported",
				"Tazapay payout needs the recipient's bank details",
			)
		}
		const known =
			endpoint.partnerRefs?.[BENEFICIARY_REF] ??
			this.beneficiaries.get(endpoint.endpointId)
		if (known) return { id: known, created: false }
		const accountNumber = endpoint.details?.accountNumber
		if (!accountNumber) {
			const fallback = this.sandboxFallback()
			if (fallback) return { id: fallback, created: false }
			throw new ProviderError(
				"unsupported",
				`Tazapay payout for endpoint ${endpoint.endpointId} needs its bank details`,
			)
		}
		const id = await this.createBeneficiary(endpoint)
		this.beneficiaries.set(endpoint.endpointId, id)
		return { id, created: true }
	}

	private sandboxFallback(): string | null {
		return this.baseUrl === SANDBOX_BASE_URL
			? this.opts.sandboxBeneficiaryId
			: null
	}

	/** Reads required_bank_fields/required_bank_codes, then creates the named beneficiary. */
	private async createBeneficiary(endpoint: EndpointRef): Promise<string> {
		if (!endpoint.recipientName) {
			throw new ProviderError(
				"unsupported",
				`Tazapay beneficiary for endpoint ${endpoint.endpointId} needs the recipient name`,
			)
		}
		const details = endpoint.details ?? {}
		const required = await this.requiredBankFields(endpoint)
		const missing: string[] = []
		for (const field of required.fields) {
			const key = BANK_FIELD_KEYS[field]
			if (!key) missing.push(`${field} (no FlexiPay detail key)`)
			else if (
				!details[key] &&
				!(key === "accountHolderName" && endpoint.recipientName)
			)
				missing.push(`${key} (required_bank_fields: ${field})`)
		}
		for (const code of required.codes) {
			const key = BANK_CODE_KEYS[code]
			if (!key) missing.push(`${code} (no FlexiPay bank code)`)
			else if (!details[key])
				missing.push(`${key} (required_bank_codes: ${code})`)
		}
		if (missing.length > 0) {
			throw new ProviderError(
				"unsupported",
				`Tazapay beneficiary for endpoint ${endpoint.endpointId} is missing ${missing.join(", ")}; required_bank_fields: ${required.fields.join(", ") || "none"}; required_bank_codes: ${required.codes.join(", ") || "none"}`,
			)
		}

		const bank: Record<string, unknown> = {
			account_number: details.accountNumber,
			country: endpoint.country,
			currency: endpoint.currency,
		}
		// The holder name defaults to the recipient's name when the details leave it out.
		bank.account_holder_name = details.accountHolderName ?? endpoint.recipientName
		if (details.bankName) bank.bank_name = details.bankName
		if (details.iban) bank.iban = details.iban
		const codes: Record<string, string> = {}
		for (const code of required.codes) {
			const value = details[BANK_CODE_KEYS[code]!]
			if (value) codes[code] = value
		}
		if (details.swiftCode && !codes.swift_code) codes.swift_code = details.swiftCode
		if (details.bankCode && !codes.bank_code) codes.bank_code = details.bankCode
		if (details.branchCode && !codes.branch_code)
			codes.branch_code = details.branchCode
		if (Object.keys(codes).length > 0) bank.bank_codes = codes

		const data = this.ok(
			await this.call("POST", "/v3/beneficiary", {
				name: endpoint.recipientName,
				type:
					endpoint.recipientKind === "company" ? "business" : "individual",
				email: this.opts.beneficiaryEmail ?? DEFAULT_BENEFICIARY_EMAIL,
				destination_details: { type: "bank", bank },
			}),
			"beneficiary",
		)
		if (typeof data.id !== "string" || data.id.length === 0) {
			throw new Error("Tazapay create beneficiary returned no id")
		}
		return data.id
	}

	private async requiredBankFields(
		endpoint: EndpointRef,
	): Promise<{ fields: string[]; codes: string[] }> {
		const data = this.ok(
			await this.call(
				"GET",
				`/v3/metadata/payout/bank?country=${encodeURIComponent(endpoint.country)}&currency=${encodeURIComponent(endpoint.currency)}`,
			),
			"payout bank metadata",
		)
		const methods = Array.isArray(data.payout_methods)
			? data.payout_methods
					.map((m) => objectOf(m))
					.filter((m): m is Record<string, unknown> => m !== null)
			: []
		const method =
			methods.find(
				(m) =>
					m.payout_type === "local" &&
					m.country === endpoint.country &&
					m.currency === endpoint.currency,
			) ??
			methods.find(
				(m) =>
					m.country === endpoint.country && m.currency === endpoint.currency,
			) ??
			methods.find((m) => m.payout_type === "local")
		if (!method) {
			throw new ProviderError(
				"unsupported",
				`Tazapay has no local bank payout method for ${endpoint.country}/${endpoint.currency}`,
			)
		}
		return {
			fields: stringList(method.required_bank_fields),
			codes: stringList(method.required_bank_codes),
		}
	}

	async status(externalRef: string): Promise<ProviderLegState> {
		if (externalRef.startsWith(CONVERT_REF))
			return { status: "succeeded", externalRef }
		this.assertEnvironment()
		const res = await this.call(
			"GET",
			`/v3/payout/${encodeURIComponent(externalRef)}`,
		)
		if (res.status === 404)
			throw new ProviderError(
				"unknown_reference",
				`Tazapay has no payout ${externalRef}`,
			)
		const data = this.ok(res, "payout status")
		const raw = typeof data.status === "string" ? data.status : ""
		const status = PAYOUT_STATUS[raw] ?? "processing"
		if (status === "failed") {
			const failure = objectOf(data.failure)
			const detail =
				typeof failure?.code === "string"
					? failure.code
					: typeof data.status_description === "string"
						? data.status_description
						: raw
			return {
				status,
				externalRef,
				error: {
					code: "provider_down",
					message: `Tazapay payout ${raw}${detail ? ` (${detail})` : ""}`,
				},
			}
		}
		return { status, externalRef }
	}

	async reverse(externalRef: string): Promise<{ externalRef: string }> {
		// The convert step is only a record (the money converts inside the payout), so undoing it
		// moves nothing.
		if (externalRef.startsWith(CONVERT_REF))
			return { externalRef: `${externalRef}:reversed` }
		throw new ProviderError(
			"not_reversible",
			"A Tazapay payout cannot be reversed",
		)
	}

	async health(): Promise<"up" | "down"> {
		const t = this.now()
		if (this.healthCache && t - this.healthCache.at < HEALTH_TTL_MS)
			return this.healthCache.value
		let value: "up" | "down" = "down"
		if (this.baseUrl !== PRODUCTION_BASE_URL || this.opts.liveApproved) {
			try {
				const payout = this.payoutCurrencies()[0]
				const country = this.row.countries[0]
				if (payout && country) {
					this.ok(
						await this.call(
							"GET",
							`/v3/metadata/payout/bank?country=${encodeURIComponent(country)}&currency=${encodeURIComponent(payout)}`,
						),
						"payout bank metadata",
					)
					value = "up"
				}
			} catch {
				value = "down"
			}
		}
		this.healthCache = { at: t, value }
		return value
	}

	/** Row currencies that are payout currencies (not holding inputs). */
	private payoutCurrencies(): string[] {
		return this.row.currencies.filter((c) => !(c in HOLDING))
	}

	private holdingFor(currency: string): string {
		const holding = HOLDING[currency]
		if (!holding || !this.row.currencies.includes(currency)) {
			throw new ProviderError(
				"unsupported",
				`Tazapay does not convert from ${currency}`,
			)
		}
		return holding
	}

	private countryFor(req: LegQuoteRequest): string {
		if (req.endpoint?.country) return req.endpoint.country
		if (this.row.countries.length === 1) return this.row.countries[0]!
		throw new ProviderError(
			"unsupported",
			"Tazapay needs the destination country to quote",
		)
	}

	private assertEnvironment() {
		if (this.baseUrl === PRODUCTION_BASE_URL && !this.opts.liveApproved) {
			throw new ProviderError(
				"unsupported",
				"Tazapay production is not approved for real money",
			)
		}
	}

	private assertServes(kind: string) {
		if (!this.row.legKinds.includes(kind as Provider["legKinds"][number])) {
			throw new ProviderError("unsupported", `Tazapay does not serve ${kind}`)
		}
	}

	private assertCurrency(currency: string) {
		if (!this.payoutCurrencies().includes(currency)) {
			throw new ProviderError(
				"unsupported",
				`Tazapay does not pay out ${currency}`,
			)
		}
	}

	private call(
		method: "GET" | "POST",
		path: string,
		body?: unknown,
		idempotencyKey?: string,
	) {
		const auth = Buffer.from(
			`${this.opts.apiKey}:${this.opts.apiSecret}`,
		).toString("base64")
		return jsonRequest(this.fetchImpl, {
			method,
			url: `${this.baseUrl}${path}`,
			headers: {
				Authorization: `Basic ${auth}`,
				...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
			},
			body,
		})
	}

	/** Tazapay wraps every success in `{ status, message, data }`; returns `data`. */
	private ok(res: HttpResult, what: string): Record<string, unknown> {
		const json = objectOf(res.json)
		const data = objectOf(json?.data)
		if (res.status >= 200 && res.status < 300 && data) return data
		const errors = Array.isArray(json?.errors) ? json.errors : []
		const first = objectOf(errors[0])
		const detail =
			typeof first?.message === "string"
				? first.message
				: typeof json?.message === "string"
					? json.message
					: "no detail"
		throw new Error(
			`Tazapay ${what} failed (HTTP ${res.status}: ${detail.slice(0, 200)})`,
		)
	}
}
