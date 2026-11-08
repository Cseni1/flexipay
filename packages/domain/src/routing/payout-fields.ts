import type {
	EndpointRef,
	PayoutFieldRequirements,
	RecipientAddress,
} from "../adapters.ts";

const ADDRESS_LOCAL: Record<string, keyof RecipientAddress> = {
	"address.line1": "line1",
	"address.line2": "line2",
	"address.city": "city",
	"address.state": "state",
	"address.postal_code": "postalCode",
	"address.country": "country",
};

function addressValue(
	address: RecipientAddress | undefined,
	local: string,
): string | undefined {
	const key = ADDRESS_LOCAL[local];
	if (!key || !address) return undefined;
	const value = address[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * CCR-43: names of partner-required payout fields that are not on this endpoint
 * or recipient. Detail keys come from required_bank_fields / required_bank_codes.
 * localFields (address.line1, …) come from the partner's local_fields.
 */
export function missingPartnerPayoutFields(
	endpoint: EndpointRef,
	requirements: PayoutFieldRequirements,
): string[] {
	const missing: string[] = [];
	const details = endpoint.details;
	for (const key of requirements.detailKeys) {
		const value = details?.[key];
		if (value && value.length > 0) continue;
		if (key === "accountHolderName" && endpoint.recipientName) continue;
		missing.push(key);
	}
	for (const local of requirements.localFields) {
		if (local.startsWith("address.")) {
			if (!addressValue(endpoint.recipientAddress, local)) missing.push(local);
			continue;
		}
		missing.push(local);
	}
	return missing;
}

export function partnerPayoutExclusionReason(
	providerId: string,
	country: string,
	missing: readonly string[],
): string {
	return `Provider ${providerId} excluded: ${country} payout needs ${missing.join(", ")}`;
}
