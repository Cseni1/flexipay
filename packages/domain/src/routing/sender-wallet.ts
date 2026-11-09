import type { Corridor } from "../config/schemas.ts";
import { ProviderError, type ProviderAdapter } from "../adapters.ts";
import type { CreateQuoteRequest } from "../api/quotes.ts";
import { money, toMinor, type Money } from "../money.ts";
import type { PriceDeps, PriceResult, PricedLeg } from "./price.ts";

/** Settle rail for a BlindPay payout funded by the sender's own Solana wallet (CCR-45). */
export const SENDER_WALLET_BLINDPAY_RAIL = "sender_wallet_blindpay";
/** Settle rail for a Due payout funded by the sender's own Solana wallet (CCR-51). */
export const SENDER_WALLET_DUE_RAIL = "sender_wallet_due";

/** True for any settle rail where the sender's own wallet funds the partner (no treasury, no vault). */
export function isSenderWalletRail(rail: string | null | undefined): boolean {
	return rail === SENDER_WALLET_BLINDPAY_RAIL || rail === SENDER_WALLET_DUE_RAIL;
}

interface SenderWalletPartner {
	/** Settle mode / rail name used in refusal reasons. */
	mode: string;
	rail: string;
	implementation: string;
	label: string;
}

const BLINDPAY_PARTNER: SenderWalletPartner = {
	mode: "sender_wallet_blindpay",
	rail: SENDER_WALLET_BLINDPAY_RAIL,
	implementation: "blindpay",
	label: "BlindPay",
};

const DUE_PARTNER: SenderWalletPartner = {
	mode: "sender_wallet_due",
	rail: SENDER_WALLET_DUE_RAIL,
	implementation: "due",
	label: "Due",
};

const USDC_PER_USD_MINOR = 100_000n;

function toUsdc(send: Money): Money | null {
	if (send.currency === "USDC") return send;
	if (send.currency === "USD") return money(toMinor(send) * USDC_PER_USD_MINOR, "USDC");
	return null;
}

/** The partner's USDC fee shown in the send currency. USD and USDC are the same dollar. */
function feeInSendCurrency(fee: Money, sendCurrency: string): Money {
	if (fee.currency === sendCurrency || toMinor(fee) === 0n) {
		return toMinor(fee) === 0n ? money(0n, sendCurrency) : fee;
	}
	if (fee.currency === "USDC" && sendCurrency === "USD") {
		return money(toMinor(fee) / USDC_PER_USD_MINOR, "USD");
	}
	return fee;
}

/**
 * CCR-45: settle (no vault) then a BlindPay payout. The sender pays USDC from their
 * own wallet. One US dollar is one USDC. BlindPay's FX quote prices the bank leg.
 */
export function priceSenderWalletBlindpay(
	deps: PriceDeps,
	req: CreateQuoteRequest,
	corridor: Corridor,
): Promise<PriceResult> {
	return priceSenderWallet(deps, req, corridor, BLINDPAY_PARTNER);
}

/**
 * CCR-51: settle (no vault) then a Due payout. The sender sends USDC from their own wallet
 * straight to Due's funding address for the transfer. Due's quote prices the bank leg.
 */
export function priceSenderWalletDue(
	deps: PriceDeps,
	req: CreateQuoteRequest,
	corridor: Corridor,
): Promise<PriceResult> {
	return priceSenderWallet(deps, req, corridor, DUE_PARTNER);
}

async function priceSenderWallet(
	deps: PriceDeps,
	req: CreateQuoteRequest,
	corridor: Corridor,
	p: SenderWalletPartner,
): Promise<PriceResult> {
	if (req.destination.type !== "bank_account") {
		return {
			ok: false,
			reasons: [`${p.mode} pays a bank account`],
		};
	}
	if (req.amount.side !== "send") {
		return {
			ok: false,
			reasons: [
				`${p.mode} quotes are priced from the amount you send`,
			],
		};
	}
	const send = req.amount.value;
	if (send.currency !== corridor.from.currency) {
		return {
			ok: false,
			reasons: [
				`Send currency ${send.currency} does not match the corridor currency ${corridor.from.currency}`,
			],
		};
	}
	const usdc = toUsdc(send);
	if (!usdc) {
		return {
			ok: false,
			reasons: [
				`${p.mode} pays USDC from a Solana wallet; the send currency must be USD or USDC`,
			],
		};
	}
	const partner = deps.config.providers.find(
		(row) =>
			row.implementation === p.implementation &&
			!row.placeholder &&
			row.countries.includes(req.destination.country) &&
			row.currencies.includes(req.destination.currency) &&
			row.legKinds.includes("payout"),
	);
	if (!partner) {
		return {
			ok: false,
			reasons: [
				`No ${p.label} payout for ${req.destination.country} ${req.destination.currency}`,
			],
		};
	}
	const adapter: ProviderAdapter | undefined = deps.getProvider(partner.id);
	if (!adapter) {
		return {
			ok: false,
			reasons: [`Provider ${partner.id} is not registered`],
		};
	}
	let quoted;
	try {
		quoted = await adapter.quote({
			kind: "convert",
			amountIn: usdc,
			outCurrency: req.destination.currency,
		});
	} catch (e) {
		const message =
			e instanceof ProviderError || e instanceof Error
				? e.message
				: `${p.label} quote failed`;
		return { ok: false, reasons: [message] };
	}
	const payoutFee = feeInSendCurrency(quoted.fee, send.currency);
	const zero = money(0n, send.currency);
	const settle: PricedLeg = {
		kind: "settle",
		rail: p.rail,
		providerId: partner.id,
		simulated: partner.simulated,
		fee: zero,
		fxRate: null,
		amountIn: usdc,
		amountOut: usdc,
		estimatedTimeSeconds: 0,
	};
	const payout: PricedLeg = {
		kind: "payout",
		rail: partner.id,
		providerId: partner.id,
		simulated: quoted.simulated,
		fee: payoutFee,
		fxRate: quoted.fxRate,
		amountIn: quoted.amountOut,
		amountOut: quoted.amountOut,
		estimatedTimeSeconds: quoted.estimatedTimeSeconds,
	};
	return {
		ok: true,
		priced: {
			legs: [settle, payout],
			expectedReceive: quoted.amountOut,
			fees: {
				legs: [
					{ kind: "settle", rail: settle.rail, fee: zero },
					{ kind: "payout", rail: payout.rail, fee: payoutFee },
				],
				flexiPayFee: zero,
				total: payoutFee,
				settleUnlockedRemainder: null,
			},
			fxRate: quoted.fxRate,
			estimatedTimeSeconds: quoted.estimatedTimeSeconds,
			exclusionReasons: [
				`${p.mode}: the sender pays from their own Solana wallet. FlexiPay does not hold the funds.`,
			],
			alternatives: [],
		},
	};
}
