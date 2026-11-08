import {
	convertMoney,
	toMinor,
	type FlexiPayConfig,
	type FxRate,
	type Money,
} from "@flexipay/domain";
import type { Db } from "../db.ts";
import { ApiError } from "../errors.ts";

const PAYMENT = "FP_INDIVIDUAL_MAX_PAYMENT_USD";
const ROLLING_24H = "FP_INDIVIDUAL_MAX_24H_USD";
const ROLLING_30D = "FP_INDIVIDUAL_MAX_30D_USD";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Caps in USD cents. Null when the three variables are all unset. */
export interface IndividualLimits {
	perPayment: bigint;
	rolling24h: bigint;
	rolling30d: bigint;
}

const EXCLUDED_STATUSES = ["cancelled", "failed", "refunded", "expired"];

export function readIndividualLimits(
	env: Record<string, string | undefined> = process.env,
): IndividualLimits | null {
	const raw = [env[PAYMENT], env[ROLLING_24H], env[ROLLING_30D]].map(
		(value) => value?.trim() ?? "",
	);
	if (raw.every((value) => value === "")) return null;
	if (raw.some((value) => value === "")) {
		throw new Error(
			`Set all of ${PAYMENT}, ${ROLLING_24H} and ${ROLLING_30D}, or none of them`,
		);
	}
	return {
		perPayment: parseUsdCents(raw[0]!, PAYMENT),
		rolling24h: parseUsdCents(raw[1]!, ROLLING_24H),
		rolling30d: parseUsdCents(raw[2]!, ROLLING_30D),
	};
}

function parseUsdCents(value: string, name: string): bigint {
	if (!/^\d+(\.\d{1,2})?$/.test(value)) {
		throw new Error(`${name} must be a USD amount with at most 2 decimal places`);
	}
	const [whole, frac = ""] = value.split(".");
	const cents = BigInt(whole + frac.padEnd(2, "0"));
	if (cents <= 0n) throw new Error(`${name} must be greater than zero`);
	return cents;
}

/** USD cents for a money amount, using a direct config FX rate. USD is already cents. */
export function usdMinor(amount: Money, rates: readonly FxRate[]): bigint {
	if (amount.currency === "USD") return toMinor(amount);
	const rate = rates.find((row) => row.from === amount.currency && row.to === "USD");
	if (!rate) {
		throw new Error(`no USD rate for ${amount.currency}`);
	}
	return toMinor(convertMoney(amount, rate.rate, "USD"));
}

type StoredQuote = {
	amountSide: string;
	amountValue: string;
	amountCurrency: string;
	route: unknown;
};

export function sendAmountOfStoredQuote(quote: StoredQuote): Money {
	if (quote.amountSide === "send") {
		return { amount: quote.amountValue, currency: quote.amountCurrency };
	}
	const route = Array.isArray(quote.route) ? quote.route : [];
	const first = route[0] as { amountIn?: { amount?: string; currency?: string } } | undefined;
	const amount = first?.amountIn?.amount;
	const currency = first?.amountIn?.currency;
	if (!amount || !currency) {
		throw new Error("receive-side quote is missing the solved send amount");
	}
	return { amount, currency };
}

function remainingOf(limit: bigint, used: bigint): bigint {
	return used >= limit ? 0n : limit - used;
}

/**
 * Individual organizations only. Business senders are unchanged.
 * Throws 422 limit_exceeded with the remaining USD cents.
 */
export async function assertIndividualSenderLimit(
	db: Db,
	config: FlexiPayConfig,
	orgId: string,
	send: Money,
	now: Date = new Date(),
	env: Record<string, string | undefined> = process.env,
): Promise<void> {
	const limits = readIndividualLimits(env);
	if (!limits) return;
	const org = await db.organization.findUnique({
		where: { id: orgId },
		select: { kind: true },
	});
	if (org?.kind !== "individual") return;

	let amount: bigint;
	try {
		amount = usdMinor(send, config.fxRates);
	} catch {
		throw new ApiError(
			422,
			"limit_exceeded",
			`No USD rate for ${send.currency}, so the individual sender limit cannot be checked`,
			{
				currency: "USD",
				remaining: { payment: "0", rolling24h: "0", rolling30d: "0" },
			},
		);
	}

	const since30 = new Date(now.getTime() - 30 * DAY);
	const since24 = new Date(now.getTime() - DAY);
	const rows = await db.payment.findMany({
		where: {
			organizationId: orgId,
			createdAt: { gte: since30 },
			status: { notIn: EXCLUDED_STATUSES },
		},
		select: {
			createdAt: true,
			quote: {
				select: {
					amountSide: true,
					amountValue: true,
					amountCurrency: true,
					route: true,
				},
			},
		},
	});

	let used24 = 0n;
	let used30 = 0n;
	for (const row of rows) {
		const cents = usdMinor(sendAmountOfStoredQuote(row.quote), config.fxRates);
		used30 += cents;
		if (row.createdAt.getTime() >= since24.getTime()) used24 += cents;
	}

	const remaining = {
		payment: limits.perPayment.toString(),
		rolling24h: remainingOf(limits.rolling24h, used24).toString(),
		rolling30d: remainingOf(limits.rolling30d, used30).toString(),
	};
	const over =
		amount > limits.perPayment ||
		amount > BigInt(remaining.rolling24h) ||
		amount > BigInt(remaining.rolling30d);
	if (!over) return;
	throw new ApiError(
		422,
		"limit_exceeded",
		"This payment is above the individual sender limit",
		{
			currency: "USD",
			amount: amount.toString(),
			remaining,
		},
	);
}
