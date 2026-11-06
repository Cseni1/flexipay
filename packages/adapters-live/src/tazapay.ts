import {
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

// Tazapay payout adapter (CCR-30). Tazapay pays out local currency from a pre-funded balance;
// its stablecoin collections are a separate primitive that credits a fiat balance, so it does
// not serve our USDC convert leg. This adapter is therefore a plain `payout` provider: the
// amount in is already the beneficiary's currency (for example PHP). Pricing comes from
// Tazapay's own payout quote, with the payout currency as the holding currency so the quote
// does not hide a second FX conversion. A production base URL is refused unless
// FP_TAZAPAY_LIVE_APPROVED=1 (written approval only).

const SANDBOX_BASE_URL = "https://service-sandbox.tazapay.com"
const PRODUCTION_BASE_URL = "https://service.tazapay.com"
const HEALTH_TTL_MS = 60_000
/** Documented Tazapay purpose code: "Payment for Services". */
const DEFAULT_PURPOSE_CODE = "PYR001"

export interface TazapayOptions {
	apiKey: string
	apiSecret: string
	/** Sandbox beneficiary to pay; real recipient bank details are not in the adapter contract yet. */
	sandboxBeneficiaryId: string | null
	liveApproved: boolean
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

function minorFee(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0
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
		if (req.amountIn.currency !== req.outCurrency) {
			throw new ProviderError(
				"currency_mismatch",
				"Tazapay pays out in the beneficiary currency; a convert leg must run first",
			)
		}
		this.assertCurrency(req.outCurrency)
		const country = req.endpoint?.country || this.row.countries[0]!
		const quoted = await this.payoutQuote(req.amountIn, country)
		const amount = toMinor(req.amountIn)
		const fee = BigInt(quoted.feeMinor)
		if (fee >= amount) {
			throw new ProviderError(
				"fee_exceeds_amount",
				"Tazapay quote fee exceeds the payout amount",
			)
		}
		return {
			providerId: this.id,
			fee: money(fee, req.outCurrency),
			fxRate: null,
			amountOut: money(amount - fee, req.outCurrency),
			estimatedTimeSeconds: this.row.estimatedTimeSeconds,
			simulated: this.row.simulated,
		}
	}

	async execute(leg: LegExecution): Promise<{ externalRef: string }> {
		this.assertEnvironment()
		this.assertServes(leg.kind)
		if (leg.amountIn.currency !== leg.outCurrency) {
			throw new ProviderError(
				"currency_mismatch",
				"Tazapay pays out in the beneficiary currency; a convert leg must run first",
			)
		}
		this.assertCurrency(leg.amountIn.currency)

		const key = `${leg.legId}:${leg.attempt}`
		const known = this.issued.get(key)
		if (known) return { externalRef: known }

		const beneficiary = this.opts.sandboxBeneficiaryId
		if (!beneficiary) {
			throw new ProviderError(
				"unsupported",
				"Tazapay payout needs a sandbox beneficiary; real recipient bank details are not in the adapter contract yet",
			)
		}
		const country = leg.endpoint?.country || this.row.countries[0]!
		const quote = await this.payoutQuote(leg.amountIn, country)
		const network = await this.fundTransferNetwork(country, leg.amountIn.currency)
		const reference = `flexipay-${key}`

		const body = this.ok(
			await this.call(
				"POST",
				"/v3/payout",
				{
					amount: Number(toMinor(leg.amountIn)),
					currency: leg.amountIn.currency,
					holding_currency: leg.amountIn.currency,
					type: "local",
					purpose: this.purposeCode,
					beneficiary,
					quote: quote.id,
					reference_id: reference,
					transaction_description: "FlexiPay payout",
					local: { fund_transfer_network: network },
				},
				reference,
			),
			"payout",
		)
		const data = objectOf(body.data)
		if (typeof data?.id !== "string")
			throw new Error("Tazapay create payout returned no id")
		this.issued.set(key, data.id)
		return { externalRef: data.id }
	}

	async status(externalRef: string): Promise<ProviderLegState> {
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
		const body = this.ok(res, "payout status")
		const data = objectOf(body.data)
		const raw = typeof data?.status === "string" ? data.status : ""
		const status = PAYOUT_STATUS[raw] ?? "processing"
		if (status === "failed") {
			const failure = objectOf(data?.failure)
			const detail =
				typeof failure?.code === "string"
					? failure.code
					: typeof data?.status_description === "string"
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

	async reverse(_externalRef: string): Promise<{ externalRef: string }> {
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
				await this.metadata(this.row.countries[0]!, this.row.currencies[0]!)
				value = "up"
			} catch {
				value = "down"
			}
		}
		this.healthCache = { at: t, value }
		return value
	}

	/** Tazapay payout quote, in the payout currency. Never invents a fee or rate. */
	private async payoutQuote(
		amount: { amount: string; currency: string },
		country: string,
	): Promise<{ id: string; feeMinor: number }> {
		const body = this.ok(
			await this.call("POST", "/v3/payout/quote", {
				payout_type: "local",
				holding_info: { currency: amount.currency },
				payout_info: {
					amount: Number(toMinor(amount)),
					currency: amount.currency,
				},
				destination_info: { currency: amount.currency, country },
			}),
			"payout quote",
		)
		if (typeof body.id !== "string")
			throw new Error("Tazapay payout quote returned no id")
		const feeInfo = objectOf(body.fee_info)
		if (!feeInfo)
			throw new Error("Tazapay payout quote returned no fee_info")
		const fixed = objectOf(feeInfo.fixed)
		const variable = objectOf(feeInfo.variable)
		const feeMinor =
			minorFee(fixed?.in_payout_currency) +
			minorFee(variable?.in_payout_currency)
		if (!Number.isInteger(feeMinor) || feeMinor < 0)
			throw new Error("Tazapay payout quote returned an invalid fee")
		return { id: body.id, feeMinor }
	}

	/** First local fund transfer network Tazapay reports for this corridor. */
	private async fundTransferNetwork(
		country: string,
		currency: string,
	): Promise<string> {
		const body = await this.metadata(country, currency)
		const data = objectOf(body.data)
		const methods = Array.isArray(data?.payout_methods)
			? data.payout_methods
			: []
		for (const method of methods) {
			const m = objectOf(method)
			if (
				m?.currency !== currency ||
				m?.payout_type !== "local" ||
				!Array.isArray(m.fund_transfer_networks)
			)
				continue
			for (const network of m.fund_transfer_networks) {
				const n = objectOf(network)
				if (typeof n?.name === "string" && n.name) return n.name
			}
		}
		throw new ProviderError(
			"unsupported",
			`Tazapay reports no local payout network for ${currency} in ${country}`,
		)
	}

	private async metadata(
		country: string,
		currency: string,
	): Promise<Record<string, unknown>> {
		const query = `?country=${encodeURIComponent(country)}&currency=${encodeURIComponent(currency)}`
		return this.ok(
			await this.call("GET", `/v3/metadata/payout/bank${query}`),
			"payout bank metadata",
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
		if (!this.row.currencies.includes(currency)) {
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

	private ok(res: HttpResult, what: string): Record<string, unknown> {
		if (
			res.status >= 200 &&
			res.status < 300 &&
			res.json &&
			typeof res.json === "object"
		) {
			return res.json as Record<string, unknown>
		}
		const message =
			res.json && typeof res.json === "object" && "message" in res.json
				? String((res.json as { message: unknown }).message).slice(0, 200)
				: "no detail"
		throw new Error(`Tazapay ${what} failed (HTTP ${res.status}: ${message})`)
	}
}
