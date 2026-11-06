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

// BlindPay off-ramp adapter (CCR-29). BlindPay converts USDC to local currency and pays the bank
// in one step, so it serves the convert + payout pair (routing keeps both legs on BlindPay):
// - convert: priced from BlindPay's own FX quote; executing it records the step, because the
//   conversion happens inside the payout.
// - payout: creates a BlindPay quote for the exact local amount and executes it.
// Development instances simulate settlement with the USDB test token and move no real money.
// A production instance is refused unless FP_BLINDPAY_LIVE_APPROVED=1 (written approval only).

const BASE_URL = "https://api.blindpay.com"
const SOURCE_ASSET = "USDC"
/** BlindPay amounts are integers in hundredths ("1000 represents 10.00"). */
const BLINDPAY_DECIMALS = 2
/** BlindPay minimum for bank account quotes, in hundredths. */
const MIN_REQUEST = 500n
const HEALTH_TTL_MS = 60_000

export interface BlindPaySandboxAccount {
	customerId: string
	bankAccountId: string
	walletId: string
}

export interface BlindPayOptions {
	apiKey: string
	instanceId: string
	/** Sandbox recipient used for every payout on a development instance (no real recipients yet). */
	sandbox: BlindPaySandboxAccount | null
	liveApproved: boolean
	baseUrl?: string
	fetch?: FetchLike
	now?: () => number
}

type InstanceType = "development" | "production"

const PAYOUT_STATUS: Record<string, ProviderLegState["status"]> = {
	processing: "processing",
	on_hold: "processing",
	completed: "succeeded",
	failed: "failed",
	refunded: "failed",
}

/** Scales an integer amount between decimal conventions, rounding down. */
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
			`BlindPay: unknown currency ${currency}`,
		)
	return d
}

/** BlindPay quotes rates in hundredths ("549.46" means 5.4946 BRL per USDC). */
function rateFromQuotation(quotation: number): {
	scaled: bigint
	text: string
} {
	const scaled = BigInt(Math.round(quotation * 100)) // rate * 10^4
	const whole = scaled / 10_000n
	const frac = (scaled % 10_000n).toString().padStart(4, "0")
	return { scaled, text: `${whole}.${frac}` }
}

export class BlindPayAdapter implements ProviderAdapter {
	readonly id: string
	private readonly row: Provider
	private readonly opts: BlindPayOptions
	private readonly fetchImpl: FetchLike
	private readonly now: () => number
	private readonly issued = new Map<string, string>()
	private instanceType: InstanceType | null = null
	private healthCache: { at: number; value: "up" | "down" } | null = null

	constructor(row: Provider, opts: BlindPayOptions) {
		this.id = row.id
		this.row = row
		this.opts = opts
		this.fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike)
		this.now = opts.now ?? (() => Date.now())
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
		this.assertServes(req.kind)
		if (req.kind === "convert") return this.quoteConvert(req)
		// payout: the conversion already happened on the convert leg; nothing more is charged here.
		if (req.amountIn.currency !== req.outCurrency) {
			throw new ProviderError(
				"currency_mismatch",
				"BlindPay payout must be in the local currency",
			)
		}
		this.assertCurrency(req.outCurrency)
		const request = rescale(
			toMinor(req.amountIn),
			decimalsOf(req.outCurrency),
			BLINDPAY_DECIMALS,
		)
		if (request < MIN_REQUEST) {
			throw new ProviderError(
				"below_min",
				"BlindPay pays out at least 5.00 in local currency",
			)
		}
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
		if (req.amountIn.currency !== SOURCE_ASSET) {
			throw new ProviderError(
				"unsupported",
				`BlindPay converts ${SOURCE_ASSET} only`,
			)
		}
		this.assertCurrency(req.outCurrency)
		const inMinor = toMinor(req.amountIn)
		const inDecimals = decimalsOf(SOURCE_ASSET)
		const request = rescale(inMinor, inDecimals, BLINDPAY_DECIMALS)
		if (request < MIN_REQUEST) {
			throw new ProviderError("below_min", "BlindPay needs at least 5.00 USDC")
		}
		const res = await this.call(
			"POST",
			`/v1/instances/${this.opts.instanceId}/quotes/fx`,
			{
				from: SOURCE_ASSET,
				to: req.outCurrency,
				request_amount: Number(request),
				currency_type: "sender",
			},
		)
		const body = this.ok(res, "FX quote")
		const result = body.result_amount
		const quotation = body.blindpay_quotation
		if (
			typeof result !== "number" ||
			typeof quotation !== "number" ||
			quotation <= 0
		) {
			throw new Error("BlindPay FX quote returned no amount or rate")
		}
		const outMinor = rescale(
			BigInt(Math.floor(result)),
			BLINDPAY_DECIMALS,
			decimalsOf(req.outCurrency),
		)
		const rate = rateFromQuotation(quotation)
		// USDC value of what the recipient gets, at BlindPay's own rate; the rest is BlindPay's fee.
		const deliveredInUsdc =
			(rescale(outMinor, decimalsOf(req.outCurrency), inDecimals) * 10_000n) /
			rate.scaled
		const feeMinor = inMinor > deliveredInUsdc ? inMinor - deliveredInUsdc : 0n
		return {
			providerId: this.id,
			fee: money(feeMinor, SOURCE_ASSET),
			fxRate: rate.text,
			amountOut: money(outMinor, req.outCurrency),
			estimatedTimeSeconds: 0,
			simulated: this.row.simulated,
		}
	}

	async execute(leg: LegExecution): Promise<{ externalRef: string }> {
		this.assertServes(leg.kind)
		const key = `${leg.legId}:${leg.attempt}`
		const known = this.issued.get(key)
		if (known) return { externalRef: known }

		if (leg.kind === "convert") {
			const ref = `blindpay-convert:${key}`
			this.issued.set(key, ref)
			return { externalRef: ref }
		}

		const type = await this.instance()
		if (type === "production" && !this.opts.liveApproved) {
			throw new ProviderError(
				"unsupported",
				"BlindPay production instance is not approved for real money",
			)
		}
		const sandbox = this.opts.sandbox
		if (!sandbox) {
			throw new ProviderError(
				"unsupported",
				"BlindPay payout needs the recipient's bank account at BlindPay; only a sandbox account can be configured today",
			)
		}
		this.assertCurrency(leg.amountIn.currency)
		const request = rescale(
			toMinor(leg.amountIn),
			decimalsOf(leg.amountIn.currency),
			BLINDPAY_DECIMALS,
		)
		const network = type === "development" ? "solana_devnet" : "solana"
		const token = type === "development" ? "USDB" : SOURCE_ASSET

		const quote = this.ok(
			await this.call("POST", `/v1/instances/${this.opts.instanceId}/quotes`, {
				bank_account_id: sandbox.bankAccountId,
				network,
				token,
				currency_type: "receiver",
				request_amount: Number(request),
				cover_fees: false,
			}),
			"payout quote",
		)
		if (typeof quote.id !== "string")
			throw new Error("BlindPay payout quote returned no id")

		if (type === "development" && typeof quote.sender_amount === "number") {
			await this.mintTestTokens(sandbox, quote.sender_amount, key)
		}

		const payout = this.ok(
			await this.call(
				"POST",
				`/v1/instances/${this.opts.instanceId}/payouts/evm`,
				{ quote_id: quote.id, wallet_id: sandbox.walletId },
				`flexipay-${key}`,
			),
			"payout",
		)
		if (typeof payout.id !== "string")
			throw new Error("BlindPay payout returned no id")
		this.issued.set(key, payout.id)
		return { externalRef: payout.id }
	}

	/** Development only: tops up the sandbox wallet with USDB so the payout can run. */
	private async mintTestTokens(
		sandbox: BlindPaySandboxAccount,
		senderHundredths: number,
		key: string,
	) {
		const wallet = this.ok(
			await this.call(
				"GET",
				`/v1/instances/${this.opts.instanceId}/customers/${sandbox.customerId}/wallets/${sandbox.walletId}`,
			),
			"sandbox wallet",
		)
		if (typeof wallet.address !== "string")
			throw new Error("BlindPay sandbox wallet has no address")
		const amount = (Math.ceil(senderHundredths / 100) + 1).toString()
		this.ok(
			await this.call(
				"POST",
				`/v1/instances/${this.opts.instanceId}/mint-usdb-solana`,
				{ address: wallet.address, amount },
				`flexipay-mint-${key}`,
			),
			"sandbox mint",
		)
	}

	async status(externalRef: string): Promise<ProviderLegState> {
		if (externalRef.startsWith("blindpay-convert:"))
			return { status: "succeeded", externalRef }
		const res = await this.call(
			"GET",
			`/v1/instances/${this.opts.instanceId}/payouts/${encodeURIComponent(externalRef)}`,
		)
		if (res.status === 404)
			throw new ProviderError(
				"unknown_reference",
				`BlindPay has no payout ${externalRef}`,
			)
		const body = this.ok(res, "payout status")
		const raw = typeof body.status === "string" ? body.status : ""
		const status = PAYOUT_STATUS[raw] ?? "processing"
		if (status === "failed") {
			return {
				status,
				externalRef,
				error: { code: "provider_down", message: `BlindPay payout ${raw}` },
			}
		}
		return { status, externalRef }
	}

	async reverse(externalRef: string): Promise<{ externalRef: string }> {
		// The convert step is only a record (the money converts inside the payout), so undoing it moves
		// nothing. A BlindPay payout cannot be pulled back.
		if (externalRef.startsWith("blindpay-convert:"))
			return { externalRef: `${externalRef}:reversed` }
		throw new ProviderError(
			"not_reversible",
			"A BlindPay payout cannot be reversed",
		)
	}

	async health(): Promise<"up" | "down"> {
		const t = this.now()
		if (this.healthCache && t - this.healthCache.at < HEALTH_TTL_MS)
			return this.healthCache.value
		let value: "up" | "down" = "down"
		try {
			const type = await this.instance(true)
			value = type === "production" && !this.opts.liveApproved ? "down" : "up"
		} catch {
			value = "down"
		}
		this.healthCache = { at: t, value }
		return value
	}

	private async instance(refresh = false): Promise<InstanceType> {
		if (this.instanceType && !refresh) return this.instanceType
		const body = this.ok(
			await this.call("GET", `/v1/instances/${this.opts.instanceId}`),
			"instance",
		)
		const type: InstanceType =
			body.type === "development" ? "development" : "production"
		this.instanceType = type
		return type
	}

	private assertServes(kind: string) {
		if (!this.row.legKinds.includes(kind as Provider["legKinds"][number])) {
			throw new ProviderError("unsupported", `BlindPay does not serve ${kind}`)
		}
	}

	private assertCurrency(currency: string) {
		if (!this.row.currencies.includes(currency)) {
			throw new ProviderError(
				"unsupported",
				`BlindPay does not pay out ${currency}`,
			)
		}
	}

	private call(
		method: "GET" | "POST",
		path: string,
		body?: unknown,
		idempotencyKey?: string,
	) {
		return jsonRequest(this.fetchImpl, {
			method,
			url: `${this.opts.baseUrl ?? BASE_URL}${path}`,
			headers: {
				Authorization: `Bearer ${this.opts.apiKey}`,
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
		throw new Error(`BlindPay ${what} failed (HTTP ${res.status}: ${message})`)
	}
}
