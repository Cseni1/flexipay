import { type Quote } from "@flexipay/web-lib/contract"
import { providerLabel } from "./providerNames"

type Leg = Quote["route"][number]

const DESTINATION_WORDS: Record<string, string> = {
	bank_account: "their bank",
	ewallet: "their e-wallet",
	crypto_wallet: "their wallet",
}

const SOURCE_WORDS: Record<string, string> = {
	bank_account: "your bank",
	ewallet: "your e-wallet",
	crypto_wallet: "your wallet",
}

const chainName = (rail: string): string =>
	rail.includes("solana")
		? "Solana"
		: rail.includes("stellar")
			? "Stellar"
			: "the network"

/** One plain-English line per leg; no rail ids. */
export function plainStep(leg: Leg, quote: Quote): string {
	switch (leg.kind) {
		case "collect":
			return `We collect your money from ${SOURCE_WORDS[quote.source.type] ?? "you"}`
		case "convert":
			return `Changed into ${leg.amountOut.currency === "TGBP" ? "digital pounds" : leg.amountOut.currency === "USDC" ? "digital dollars" : leg.amountOut.currency}`
		case "settle":
			return `Moved on ${chainName(leg.rail)} in seconds`
		case "payout":
			return `${providerLabel(leg.providerId || leg.rail)} pays it into ${DESTINATION_WORDS[quote.destination.type] ?? "their account"}`
	}
}

/** "1 GBP = 77.7193 PHP", or null when there is no conversion. */
export function rateLine(quote: Quote): string | null {
	const from = quote.amount.value.currency
	const to = quote.expectedReceive.currency
	if (!quote.fxRate || from === to) return null
	const rate = Number(quote.fxRate)
	if (!Number.isFinite(rate) || rate <= 0) return null
	const shown = rate.toLocaleString("en-GB", { maximumFractionDigits: 4 })
	return `1 ${from} = ${shown} ${to}`
}
