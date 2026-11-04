import { z } from "zod";
import { ApiError } from "../errors.ts";
import { createOnrampOrder, loadCrossmintConfig, OnrampError } from "../onramp/crossmint.ts";
import { defineRoute, type RouteDef } from "../routes.ts";
import { getSolanaRuntimeConfig } from "../solana/runtime-config.ts";

// Add funds by card (Crossmint, staging). Customer session only: the order is tied to the
// signed-in user's email and a wallet address they choose.

const MIN_USD = 5;
const MAX_USD = 100;
const WINDOW_MS = 10 * 60_000;
const MAX_ORDERS_PER_WINDOW = 10;
const recent = new Map<string, number[]>();

function tooMany(userId: string, now = Date.now()): boolean {
	const hits = (recent.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
	if (hits.length >= MAX_ORDERS_PER_WINDOW) {
		recent.set(userId, hits);
		return true;
	}
	hits.push(now);
	recent.set(userId, hits);
	return false;
}

const Body = z
	.object({
		walletAddress: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a Solana address"),
		amountUsd: z
			.string()
			.regex(/^[1-9][0-9]{0,2}$/, "whole USD amount")
			.refine((v) => Number(v) >= MIN_USD && Number(v) <= MAX_USD, `between ${MIN_USD} and ${MAX_USD}`),
	})
	.strict();

const Order = z.object({ orderId: z.string(), clientSecret: z.string() }).strict();

export const onrampRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "post",
		path: "/v1/onramp/orders",
		summary: "Create a test-mode card order that delivers devnet USDC to the user's wallet",
		auth: "session",
		body: Body,
		success: { status: 201, schema: Order },
		handler: async (ctx, { body }) => {
			const actor = ctx.actor;
			if (!actor || actor.kind !== "session") {
				throw new ApiError(401, "unauthorized", "sign in required");
			}
			const cfg = loadCrossmintConfig();
			if (!cfg) {
				throw new ApiError(422, "onramp_unavailable", "Card payments are not configured.");
			}
			const solana = getSolanaRuntimeConfig();
			if (solana.cluster !== "devnet") {
				throw new ApiError(422, "onramp_unavailable", "Card payments are available on devnet only.");
			}
			if (tooMany(actor.userId)) {
				throw new ApiError(422, "rate_limited", "Too many card orders. Try again in a few minutes.");
			}
			try {
				return await createOnrampOrder(cfg, {
					email: actor.email,
					walletAddress: body.walletAddress,
					amountUsd: body.amountUsd,
					usdcMint: solana.usdcMint,
				});
			} catch (e) {
				if (e instanceof OnrampError) {
					if (e.kind === "rejected") throw new ApiError(422, "onramp_rejected", e.message);
					throw new ApiError(502, "onramp_unavailable", e.message);
				}
				throw e;
			}
		},
	}),
];
