import {
	missingPartnerPayoutFields,
	PlannedLegSchema,
	type EndpointRef,
	type ProviderAdapter,
} from "@flexipay/domain";
import { z } from "zod";
import type { Db } from "../db.ts";
import { recipientAddressOf } from "./run.ts";

const RouteSchema = z.array(PlannedLegSchema);

/**
 * CCR-48: before a direct payment is created, check the saved endpoint and recipient against
 * the payout partner's required fields (CCR-43). The quote check only sees the quote's payout
 * profile; this sees what the payout leg will actually send, so a missing address or branch
 * code stops the payment before the sender pays instead of failing after funding.
 *
 * Returns the missing field names (empty when complete or not checkable). A partner whose
 * requirements cannot be read is not blocked here; the payout leg still checks it.
 */
export async function missingPayoutFieldsForPayment(
	db: Db,
	getProvider: (id: string) => ProviderAdapter | undefined,
	input: {
		organizationId: string;
		quoteRoute: unknown;
		endpointId: string;
	},
): Promise<{ providerId: string; missing: string[] } | null> {
	const parsed = RouteSchema.safeParse(input.quoteRoute);
	if (!parsed.success) return null;
	const payoutLeg = parsed.data.find((l) => l.kind === "payout");
	if (!payoutLeg) return null;
	const adapter = getProvider(payoutLeg.providerId);
	if (!adapter?.payoutRequirements) return null;
	const endpoint = await db.endpoint.findFirst({
		where: { id: input.endpointId, organizationId: input.organizationId },
		include: { recipient: true },
	});
	if (!endpoint?.country) return null;
	if (endpoint.type !== "bank_account" && endpoint.type !== "ewallet") return null;
	let requirements;
	try {
		requirements = await adapter.payoutRequirements(endpoint.country, endpoint.currency);
	} catch {
		return null;
	}
	if (!requirements) return null;
	const ref: EndpointRef = {
		endpointId: endpoint.id,
		type: endpoint.type,
		country: endpoint.country,
		currency: endpoint.currency,
		details: (endpoint.details as Record<string, string> | null) ?? {},
		recipientName: endpoint.recipient?.name,
		recipientAddress: recipientAddressOf(endpoint.recipient),
	};
	const missing = missingPartnerPayoutFields(ref, requirements);
	return missing.length > 0 ? { providerId: adapter.id, missing } : null;
}
