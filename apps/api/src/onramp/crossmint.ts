import { z } from "zod";

// Crossmint onramp (card -> devnet USDC) for the Add funds panel.
//
// Server key stays here; the browser only receives the short-lived order id + client secret.
// STAGING ONLY: a production key (or CROSSMINT_ENV other than "staging") disables the feature,
// because production means real money and needs Csenge's written approval.

export interface CrossmintConfig {
	serverKey: string;
	baseUrl: string;
}

export function loadCrossmintConfig(
	env: Record<string, string | undefined> = process.env,
): CrossmintConfig | null {
	const serverKey = env.CROSSMINT_SERVER_KEY?.trim();
	if (!serverKey) return null;
	if (env.CROSSMINT_ENV?.trim() !== "staging") return null;
	if (/production/i.test(serverKey)) return null;
	return { serverKey, baseUrl: "https://staging.crossmint.com" };
}

export class OnrampError extends Error {
	kind: "rejected" | "unavailable";
	constructor(kind: "rejected" | "unavailable", message: string) {
		super(message);
		this.kind = kind;
	}
}

const OrderResponse = z.object({
	order: z.object({ orderId: z.string().min(1) }).passthrough(),
	clientSecret: z.string().min(1),
});

export type CreateOrderInput = {
	email: string;
	walletAddress: string;
	amountUsd: string;
	/** SPL mint of the devnet USDC the order delivers. */
	usdcMint: string;
};

export async function createOnrampOrder(
	cfg: CrossmintConfig,
	input: CreateOrderInput,
	fetchImpl: typeof fetch = fetch,
): Promise<{ orderId: string; clientSecret: string }> {
	const headers = { "x-api-key": cfg.serverKey, "content-type": "application/json" };
	const call = async (url: string, init: RequestInit): Promise<Response> => {
		try {
			return await fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(20_000) });
		} catch {
			throw new OnrampError("unavailable", "The card provider could not be reached.");
		}
	};

	// 1. A wallet outside Crossmint (Phantom etc.) must be linked to the user's email first.
	const link = await call(
		`${cfg.baseUrl}/api/2025-06-09/users/email:${encodeURIComponent(input.email)}/linked-wallets/${encodeURIComponent(input.walletAddress)}`,
		{ method: "PUT", body: JSON.stringify({ chain: "solana" }) },
	);
	if (link.status >= 500) throw new OnrampError("unavailable", "The card provider is unavailable.");
	if (!link.ok && link.status !== 409) {
		throw new OnrampError("rejected", "The card provider did not accept this wallet.");
	}

	// 2. Create the order.
	const res = await call(`${cfg.baseUrl}/api/2022-06-09/orders`, {
		method: "POST",
		body: JSON.stringify({
			lineItems: [
				{
					tokenLocator: `solana:${input.usdcMint}`,
					executionParameters: { mode: "exact-in", amount: input.amountUsd },
				},
			],
			payment: { method: "card", receiptEmail: input.email },
			recipient: { walletAddress: input.walletAddress },
		}),
	});
	if (res.status >= 500) throw new OnrampError("unavailable", "The card provider is unavailable.");
	if (!res.ok) throw new OnrampError("rejected", "The card provider did not accept this order.");
	const parsed = OrderResponse.safeParse(await res.json().catch(() => null));
	if (!parsed.success) throw new OnrampError("unavailable", "The card provider returned an unexpected answer.");
	return { orderId: parsed.data.order.orderId, clientSecret: parsed.data.clientSecret };
}
