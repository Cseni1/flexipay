import {
	ProviderError,
	subtractMoney,
	type EndpointRef,
	type FxRate,
	type LegExecution,
	type LegKind,
	type LegQuote,
	type LegQuoteRequest,
	type LegFailureCode,
	type Money,
	type Provider,
	type ProviderAdapter,
	type ProviderCapabilities,
	type ProviderLegState,
} from "@flexipay/domain"
import type { ProviderOverride } from "./overrides.ts"
import {
	assertFeeBelowInput,
	assertWithinLimits,
	convertWithSpread,
	feeFor,
	rateFor,
} from "./pricing.ts"

// Simulated provider adapters (ARCHITECTURE §11.1, CCR-4). One configuration-driven class serves
// the six baseline providers: every fee, spread, rate, time and limit is read from config, so no
// number is hard-coded and no price is presented as real. A leg completes immediately because the
// contract holds no clock: nothing waits and no timer is used.

interface LegRecord {
	state: ProviderLegState
	kind: LegKind
	reversible: boolean
}

const isReversible = (kind: LegKind): boolean =>
	kind === "collect" || kind === "convert"

export class SimProviderAdapter implements ProviderAdapter {
	readonly id: string
	private readonly row: Provider
	private readonly rates: FxRate[]
	private readonly override: ProviderOverride
	private readonly legs = new Map<string, LegRecord>()
	private readonly reversals = new Map<string, string>()

	constructor(row: Provider, rates: FxRate[], override: ProviderOverride) {
		this.row = row
		this.rates = rates
		this.override = override
		this.id = row.id
	}

	capabilities(): ProviderCapabilities {
		return {
			providerId: this.id,
			countries: [...this.row.countries],
			currencies: [...this.row.currencies],
			endpointTypes: [...this.row.endpointTypes],
			legKinds: [...this.row.legKinds],
			limits: this.row.limits
				? { min: { ...this.row.limits.min }, max: { ...this.row.limits.max } }
				: null,
			simulated: this.row.simulated,
		}
	}

	async quote(req: LegQuoteRequest): Promise<LegQuote> {
		this.assertServes(req.kind)
		const amountIn = req.amountIn

		if (req.kind === "convert") {
			const rate = rateFor(this.rates, amountIn.currency, req.outCurrency)
			assertWithinLimits(this.row, amountIn)
			const fee = feeFor(this.row, amountIn)
			assertFeeBelowInput(this.row, fee, amountIn)
			return {
				providerId: this.id,
				fee,
				fxRate: rate.rate,
				amountOut: convertWithSpread(
					subtractMoney(amountIn, fee),
					rate,
					this.row.fxSpreadBps,
				),
				estimatedTimeSeconds: this.row.estimatedTimeSeconds,
				simulated: this.row.simulated,
			}
		}

		this.assertDeliverable(req.kind, amountIn, req.outCurrency, req.endpoint)
		assertWithinLimits(this.row, amountIn)
		const fee = feeFor(this.row, amountIn)
		assertFeeBelowInput(this.row, fee, amountIn)
		return {
			providerId: this.id,
			fee,
			fxRate: null,
			amountOut: subtractMoney(amountIn, fee),
			estimatedTimeSeconds: this.row.estimatedTimeSeconds,
			simulated: this.row.simulated,
		}
	}

	/**
	 * Idempotent per (legId, attempt): a replay returns the reference it already issued and never
	 * changes state, so a failed or reversed leg is never revived (CCR-4 §4).
	 */
	async execute(leg: LegExecution): Promise<{ externalRef: string }> {
		this.assertServes(leg.kind)
		if (leg.kind === "convert") {
			rateFor(this.rates, leg.amountIn.currency, leg.outCurrency)
		} else {
			this.assertDeliverable(
				leg.kind,
				leg.amountIn,
				leg.outCurrency,
				leg.endpoint,
			)
		}
		assertWithinLimits(this.row, leg.amountIn)
		assertFeeBelowInput(this.row, feeFor(this.row, leg.amountIn), leg.amountIn)

		const externalRef = `${this.id}:${leg.paymentId}:${leg.legId}:${leg.attempt}`
		if (this.legs.has(externalRef)) return { externalRef }

		const failure = this.nextFailure()
		const state: ProviderLegState = failure
			? {
					status: "failed",
					externalRef,
					error: { code: failure, message: this.failureMessage(failure) },
				}
			: { status: "succeeded", externalRef }
		this.legs.set(externalRef, {
			state,
			kind: leg.kind,
			reversible: isReversible(leg.kind),
		})
		return { externalRef }
	}

	async status(externalRef: string): Promise<ProviderLegState> {
		const record = this.legs.get(externalRef)
		if (!record) {
			throw new ProviderError(
				"unknown_reference",
				`${this.id} has no leg ${externalRef}`,
			)
		}
		const { state } = record
		return state.error ? { ...state, error: { ...state.error } } : { ...state }
	}

	/** Only a succeeded collect or convert leg reverses, and the reversal is idempotent. */
	async reverse(externalRef: string): Promise<{ externalRef: string }> {
		const record = this.legs.get(externalRef)
		if (!record) {
			throw new ProviderError(
				"unknown_reference",
				`${this.id} has no leg ${externalRef}`,
			)
		}
		if (!record.reversible) {
			throw new ProviderError(
				"not_reversible",
				`${this.id} cannot reverse a ${record.kind} leg`,
			)
		}
		if (record.state.status !== "succeeded") {
			throw new ProviderError(
				"not_succeeded",
				`${externalRef} is ${record.state.status}`,
			)
		}
		const existing = this.reversals.get(externalRef)
		if (existing) return { externalRef: existing }

		const reversalRef = `${externalRef}:reversal`
		this.reversals.set(externalRef, reversalRef)
		this.legs.set(reversalRef, {
			state: { status: "succeeded", externalRef: reversalRef },
			kind: record.kind,
			reversible: false,
		})
		return { externalRef: reversalRef }
	}

	async health(): Promise<"up" | "down"> {
		return this.override.health
	}

	/** CCR-4 §1: a down provider wins over a pending failure, and failNext is consumed per run. */
	private nextFailure(): LegFailureCode | undefined {
		if (this.override.health === "down") return "provider_down"
		if (this.override.forcedFailure) return "sandbox_forced_failure"
		if (this.override.failNext > 0) {
			this.override.failNext -= 1
			return "sandbox_forced_failure"
		}
		return undefined
	}

	private failureMessage(code: LegFailureCode): string {
		return code === "provider_down"
			? `${this.id} is marked down by the sandbox`
			: `${this.id} failed on request from the sandbox`
	}

	private assertServes(kind: LegKind): void {
		if (!this.row.legKinds.includes(kind)) {
			throw new ProviderError(
				"unsupported",
				`${this.id} does not serve the ${kind} leg`,
			)
		}
	}

	/** A convert leg is priced from the rate table; every other leg delivers one currency. */
	private assertDeliverable(
		kind: LegKind,
		amountIn: Money,
		outCurrency: string,
		endpoint?: EndpointRef,
	): void {
		if (!this.row.currencies.includes(amountIn.currency)) {
			throw new ProviderError(
				"currency_mismatch",
				`${this.id} does not serve ${amountIn.currency}`,
			)
		}
		if (outCurrency !== amountIn.currency) {
			throw new ProviderError(
				"currency_mismatch",
				`${this.id} cannot deliver ${outCurrency} for a ${amountIn.currency} ${kind} leg`,
			)
		}
		if (kind !== "payout") return

		if (!endpoint) {
			throw new ProviderError(
				"unsupported",
				`${this.id} needs a destination endpoint for a payout`,
			)
		}
		if (!this.row.endpointTypes.includes(endpoint.type)) {
			throw new ProviderError(
				"unsupported",
				`${this.id} does not serve ${endpoint.type} endpoints`,
			)
		}
		if (!this.row.countries.includes(endpoint.country)) {
			throw new ProviderError(
				"unsupported",
				`${this.id} does not serve ${endpoint.country} endpoints`,
			)
		}
		if (endpoint.currency !== outCurrency) {
			throw new ProviderError(
				"currency_mismatch",
				`${this.id} cannot deliver ${outCurrency} to a ${endpoint.currency} endpoint`,
			)
		}
	}
}
