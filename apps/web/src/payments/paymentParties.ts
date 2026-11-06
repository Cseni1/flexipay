import { type Event } from "@flexipay/web-lib/contract"
import { type EndpointSummary } from "../api/client"
import { shortAddress } from "../solana/walletStandard"

/** Paying wallet from payment.onchain snapshot.payer, when present. */
export function payerFromEvents(events: readonly Event[]): string | null {
	for (const event of events) {
		if (event.type !== "payment.onchain") continue
		const payer = event.snapshot?.payer
		if (typeof payer === "string" && payer.trim()) return payer.trim()
	}
	return null
}

/** Destination address from payment.onchain snapshot.destination, when present. */
export function onchainDestinationFromEvents(
	events: readonly Event[],
): string | null {
	for (const event of events) {
		if (event.type !== "payment.onchain") continue
		const destination = event.snapshot?.destination
		if (typeof destination === "string" && destination.trim()) {
			return destination.trim()
		}
	}
	return null
}

/** Mask a bank account / phone so only the last four characters show. */
export function maskAccount(value: string): string {
	const trimmed = value.trim()
	if (trimmed.length <= 4) return trimmed
	return `••••${trimmed.slice(-4)}`
}

/**
 * Human destination label: short wallet, masked bank/phone, or on-chain dest.
 */
export function formatDestinationLabel(
	endpoint: EndpointSummary | null | undefined,
	onchainDestination: string | null = null,
): string {
	if (endpoint) {
		const { type, details } = endpoint
		if (type === "bank_account" && details.accountNumber) {
			return `Bank ${maskAccount(details.accountNumber)}`
		}
		if (type === "ewallet" && details.phoneNumber) {
			return `E-wallet ${maskAccount(details.phoneNumber)}`
		}
		if (
			(type === "crypto_wallet" || type === "crypto_custodial") &&
			details.address
		) {
			return shortAddress(details.address)
		}
	}
	if (onchainDestination) return shortAddress(onchainDestination)
	return "—"
}
