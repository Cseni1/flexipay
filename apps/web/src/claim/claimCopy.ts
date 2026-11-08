// Plain-words copy and pure helpers for the public claim page (ClaimPage.tsx).
import { type ClaimView } from "@flexipay/web-lib/claim-contract"
import { displayMoney, isPoundDisplayCurrency } from "../payments/quoteDisplay"
import { CLAIM_EXPIRED_ASK_SENDER } from "./expiry"

/** Icon names (from components/ui/Icon) for each way to receive money. Kept local so tests need no JSX. */
export type ClaimMethodIcon = "bank" | "phone" | "wallet" | "shield"

export type DestinationType = ClaimView["allowedDestinationTypes"][number]

/** Legacy split for non-pound claim amounts (USD/USDC/fiat). Pounds use displayMoney. */
export const CURRENCY_DECIMALS: Readonly<Record<string, number>> = {
	USD: 2,
	PHP: 2,
	BRL: 2,
	ZAR: 2,
	USDC: 7,
}

export const PAYMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
	quoted: "Quoted",
	awaiting_funding: "Waiting for payment",
	funded: "Paid in",
	processing: "On its way",
	paid: "Delivered",
	cancelled: "Cancelled",
	failed: "Failed",
	refunding: "Returning money",
	refunded: "Money returned",
	expired: "Expired",
}

/** Accept CTA only when settle is waiting (typically after fund → processing). `funded` alone yields API 409. */
export const PAYMENT_ACCEPTABLE_STATUSES = new Set(["processing"])

export const TERMINAL_PAYMENT_STATUSES = new Set([
	"paid",
	"cancelled",
	"failed",
	"refunded",
	"expired",
])

export const CLOSED_PAYMENT_STATUSES = new Set([
	"cancelled",
	"failed",
	"refunded",
	"expired",
])

export const isCrypto = (type: DestinationType): boolean =>
	type === "crypto_wallet" || type === "crypto_custodial"

// CCR-17: crypto (address) and fiat (accountNumber / phoneNumber) accept paths are mounted.
export const supportsClaimAccept = (
	type: DestinationType | "",
): type is DestinationType =>
	type === "crypto_wallet" ||
	type === "crypto_custodial" ||
	type === "bank_account" ||
	type === "ewallet"

export const optionCopy = (
	type: DestinationType,
): { title: string; detail: string; icon: ClaimMethodIcon } => {
	switch (type) {
		case "bank_account":
			return {
				title: "Bank account",
				detail: "Straight into your bank",
				icon: "bank",
			}
		case "ewallet":
			return {
				title: "E-wallet",
				detail: "To your mobile money app",
				icon: "phone",
			}
		case "crypto_wallet":
			return {
				title: "Crypto wallet",
				detail: "Digital dollars (USDC) to your own wallet",
				icon: "wallet",
			}
		case "crypto_custodial":
			return {
				title: "Custodial wallet",
				detail: "A test wallet we hold for you",
				icon: "shield",
			}
	}
}

export const detailLabel = (
	type: DestinationType,
	network: "stellar" | "solana",
): string => {
	if (isCrypto(type)) {
		return network === "solana"
			? "Solana wallet address (devnet USDC)"
			: "Stellar testnet wallet address"
	}
	if (type === "ewallet") return "E-wallet number"
	return "Bank account number"
}

export const detailPlaceholder = (
	type: DestinationType,
	network: "stellar" | "solana",
): string =>
	isCrypto(type)
		? network === "solana"
			? "Base58 address…"
			: "G…"
		: "Account details"

export const formatAmount = (
	amount: string,
	currency: string,
): { value: string; currency: string | null } => {
	if (isPoundDisplayCurrency(currency)) {
		return { value: displayMoney(amount, currency), currency: null }
	}
	const decimals = CURRENCY_DECIMALS[currency] ?? 0
	const padded = amount.padStart(decimals + 1, "0")
	const whole = decimals === 0 ? padded : padded.slice(0, -decimals)
	const fraction =
		decimals === 0
			? ""
			: padded.slice(-decimals).replace(/0+$/, "").padEnd(2, "0")
	const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
	return {
		value: fraction ? `${grouped}.${fraction}` : grouped,
		currency,
	}
}

export const claimStatusTone = (status: ClaimView["status"]): string => {
	if (status === "accepted") return "success"
	if (status === "expired") return "danger"
	return "warning"
}

export const paymentStatusTone = (status: string): string => {
	if (status === "paid") return "success"
	if (status === "failed" || status === "expired") return "danger"
	if (status === "cancelled" || status === "refunded") return "muted"
	if (status === "processing" || status === "funded") return "warning"
	return "neutral"
}

export const claimStatusLabel = (status: ClaimView["status"]): string => {
	if (status === "accepted") return "accepted"
	if (status === "expired") return "expired"
	return "open"
}

export const paymentStatusLabel = (status: string): string =>
	PAYMENT_STATUS_LABELS[status] ?? status

export const closedClaimMessage = (claim: ClaimView): string => {
	if (claim.status === "expired") {
		return CLAIM_EXPIRED_ASK_SENDER
	}
	if (claim.paymentStatus === "paid") {
		if (claim.releaseEvidence?.network === "solana") {
			return "Paid. We checked the Solana transfer on-chain before marking it paid."
		}
		return "Paid. We have confirmed your money was released."
	}
	if (claim.paymentStatus === "failed") {
		return "This payment did not go through, so nothing was marked as paid."
	}
	if (CLOSED_PAYMENT_STATUSES.has(claim.paymentStatus)) {
		return `This payment is now: ${paymentStatusLabel(claim.paymentStatus)}. It has not been paid to you.`
	}
	return "We are waiting for the sender's money to reach you. This page updates by itself, so you can leave it open."
}

export const closedClaimTitle = (claim: ClaimView): string => {
	if (claim.status === "expired") return "This link has expired"
	if (claim.paymentStatus === "paid") return "Money delivered"
	if (claim.paymentStatus === "failed") return "This payment didn't go through"
	if (CLOSED_PAYMENT_STATUSES.has(claim.paymentStatus))
		return "This payment was stopped"
	return "You're all set"
}

export const notReadyMessage = (claim: ClaimView): string => {
	if (
		claim.paymentStatus === "quoted" ||
		claim.paymentStatus === "awaiting_funding"
	) {
		return "The sender hasn't paid this in yet. Ask them to pay it, then come back to accept."
	}
	if (claim.paymentStatus === "funded") {
		return "The sender has paid in, but this is not ready to accept yet. Check back in a minute."
	}
	return `This can't be accepted while the payment is: ${paymentStatusLabel(claim.paymentStatus)}.`
}

export const closedClaimTone = (claim: ClaimView): "info" | "warning" =>
	claim.status === "expired" || CLOSED_PAYMENT_STATUSES.has(claim.paymentStatus)
		? "warning"
		: "info"
