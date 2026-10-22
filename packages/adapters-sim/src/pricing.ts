import {
	addMoney,
	applyBps,
	compareMoney,
	convertMoney,
	ProviderError,
	type FxRate,
	type Money,
	type Provider,
} from "@flexipay/domain"

// Leg pricing exactly as CCR-4 §2 and §3 define it: one fee rule, configured directional rates,
// and the domain conversion helper. Nothing here holds a number or a rate of its own.

/** fee = fixed + amountIn * bps / 10_000, rounded down, in the leg's input currency. */
export function feeFor(row: Provider, amountIn: Money): Money {
	const fixed = row.fee.fixed
	const proportional = applyBps(amountIn, row.fee.bps)
	// A zero fixed fee is valid in any currency; a nonzero one must be in the input currency.
	if (fixed.amount === "0") return proportional
	if (fixed.currency !== amountIn.currency) {
		throw new ProviderError(
			"currency_mismatch",
			`${row.id} charges its fixed fee in ${fixed.currency}, not ${amountIn.currency}`,
		)
	}
	return addMoney(fixed, proportional)
}

export function assertFeeBelowInput(
	row: Provider,
	fee: Money,
	amountIn: Money,
): void {
	if (compareMoney(fee, amountIn) >= 0) {
		throw new ProviderError(
			"fee_exceeds_amount",
			`${row.id} charges ${fee.amount} ${fee.currency} on ${amountIn.amount} ${amountIn.currency}`,
		)
	}
}

/** Limits compare the input amount; `limits: null` means the provider has none. */
export function assertWithinLimits(row: Provider, amountIn: Money): void {
	const limits = row.limits
	if (!limits) return
	if (limits.min.currency !== amountIn.currency) {
		throw new ProviderError(
			"currency_mismatch",
			`${row.id} compares limits in ${limits.min.currency}, not ${amountIn.currency}`,
		)
	}
	if (compareMoney(amountIn, limits.min) < 0) {
		throw new ProviderError(
			"below_min",
			`${row.id} takes at least ${limits.min.amount} ${limits.min.currency}`,
		)
	}
	if (compareMoney(amountIn, limits.max) > 0) {
		throw new ProviderError(
			"above_max",
			`${row.id} takes at most ${limits.max.amount} ${limits.max.currency}`,
		)
	}
}

/** The configured rate for exactly this direction; CCR-4 §2 forbids inverting another entry. */
export function rateFor(rates: FxRate[], from: string, to: string): FxRate {
	const rate = rates.find((r) => r.from === from && r.to === to)
	if (!rate) {
		throw new ProviderError(
			"no_fx_rate",
			`no configured rate ${from}>${to}; rates are never derived by inverting another`,
		)
	}
	return rate
}

/** out = convert(net) * (10_000 - spread) / 10_000, rounded down (CCR-4 §3). */
export function convertWithSpread(
	net: Money,
	rate: FxRate,
	spreadBps: number,
): Money {
	return applyBps(convertMoney(net, rate.rate, rate.to), 10_000 - spreadBps)
}
