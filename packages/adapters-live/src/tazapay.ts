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
	/** Sandbox beneficiary to pay; real recipient bank details are not in the adapter contract yet. */
	sandboxBeneficiaryId: string | null
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

	async execute(leg: LegExecution): Promise<{ externalRef: string }> {
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

		const beneficiary = this.opts.sandboxBeneficiaryId
		if (!beneficiary) {
			throw new ProviderError(
				"unsupported",
				"Tazapay payout needs a sandbox beneficiary; real recipient bank details are not in the adapter contract yet",
			)
		}
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
					beneficiary,
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
		return { externalRef: data.id }
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
