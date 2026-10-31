import type { ClaimAcceptRequest, ClaimView } from "./claim-contract.ts"

// CCR-17: claim-accept endpoint details use the same type-specific keys as CCR-16.
// Crypto uses `address`; bank uses `accountNumber`; e-wallet uses `phoneNumber`.

type ClaimEndpoint = ClaimAcceptRequest["endpoint"]
type ClaimDestinationType = ClaimView["allowedDestinationTypes"][number]

export interface ClaimEndpointInput {
	type: ClaimDestinationType
	detail: string
	currency: string
	/** Destination country from the public claim view; used only for fiat endpoints. */
	country: string
}

const isCrypto = (
	type: ClaimDestinationType,
): type is "crypto_wallet" | "crypto_custodial" =>
	type === "crypto_wallet" || type === "crypto_custodial"

export const buildClaimEndpoint = ({
	type,
	detail,
	currency,
	country,
}: ClaimEndpointInput): ClaimEndpoint => {
	if (isCrypto(type)) {
		return {
			type,
			country: "",
			currency,
			network: "stellar",
			details: { address: detail },
			simulated: true,
		}
	}
	if (type === "bank_account") {
		return {
			type,
			country,
			currency,
			network: null,
			details: { accountNumber: detail },
			simulated: true,
		}
	}
	return {
		type,
		country,
		currency,
		network: null,
		details: { phoneNumber: detail },
		simulated: true,
	}
}
