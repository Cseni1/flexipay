import {
	SolanaSwapConfirmRequestSchema,
	SolanaSwapConfirmResponseSchema,
	SolanaSwapRequestSchema,
	SolanaSwapResponseSchema,
} from "@flexipay/domain";
import { JupiterError } from "@flexipay/adapters-live";
import { isSolanaAddress } from "@flexipay/adapter-solana";
import { ApiError } from "../errors.ts";
import { defineRoute, type Ctx, type RouteDef } from "../routes.ts";
import { getSolanaRuntimeConfig } from "../solana/runtime-config.ts";
import {
	SWAP_MAX_PRICE_IMPACT,
	SWAP_SLIPPAGE_BPS,
	swapDeps,
	swapInputAssets,
} from "../solana/swap.ts";
import { hundredths, loadSenderPayment } from "./blindpay.ts";

const orgOf = (ctx: Ctx) => {
	if (!ctx.org) throw new ApiError(401, "unauthorized", "missing organization");
	return ctx.org;
};

const OPEN_STATUSES = new Set(["awaiting_funding", "funded", "processing"]);

/** USDC (base units of the configured mint) BlindPay will pull for this payment. */
async function requiredUsdc(ctx: Ctx, paymentId: string) {
	const org = orgOf(ctx);
	if (!swapInputAssets().includes("TGBP")) {
		throw new ApiError(
			409,
			"swap_unavailable",
			"Swaps to USDC run on Solana mainnet only",
		);
	}
	const { payment, payout } = await loadSenderPayment(ctx, paymentId, org.id);
	if (payout.externalRef || !OPEN_STATUSES.has(payment.status)) {
		throw new ApiError(
			409,
			"invalid_status",
			`Cannot swap for a payment in status ${payment.status}`,
		);
	}
	const cfg = getSolanaRuntimeConfig();
	const usdc = cfg.assets.find((a) => a.asset === "USDC")!;
	const tgbp = cfg.assets.find((a) => a.asset === "TGBP")!;
	const cents = BigInt(hundredths(payout.amountInValue, payout.amountInCurrency));
	const required =
		usdc.decimals >= 2
			? cents * 10n ** BigInt(usdc.decimals - 2)
			: (cents + 10n ** BigInt(2 - usdc.decimals) - 1n) / 10n ** BigInt(2 - usdc.decimals);
	return { usdc, tgbp, required };
}

function wallet(address: string): string {
	if (!isSolanaAddress(address)) {
		throw new ApiError(400, "validation_error", "walletAddress is not a Solana address");
	}
	return address;
}

export const swapRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "post",
		path: "/v1/payments/{id}/solana-swap",
		summary: "Jupiter swap (tGBP to USDC) for the sender's own wallet before a BlindPay payout",
		auth: "customer",
		body: SolanaSwapRequestSchema,
		success: { status: 200, schema: SolanaSwapResponseSchema },
		handler: async (ctx, { params, body }) => {
			const owner = wallet(body.walletAddress);
			const { usdc, tgbp, required } = await requiredUsdc(ctx, params.id!);
			const deps = swapDeps();
			const held = await deps.rpc.tokenBalance(owner, usdc.mint);
			if (held >= required) {
				return {
					status: "not_needed" as const,
					requiredAmount: required.toString(),
					heldAmount: held.toString(),
					outputDecimals: usdc.decimals,
				};
			}
			const shortfall = required - held;
			try {
				const quote = await deps.jupiter.quoteExactOut({
					inputMint: tgbp.mint,
					outputMint: usdc.mint,
					amount: shortfall,
					slippageBps: SWAP_SLIPPAGE_BPS,
				});
				if (quote.priceImpact > SWAP_MAX_PRICE_IMPACT) {
					throw new ApiError(
						422,
						"swap_price_impact",
						"This swap would move the tGBP price too much; try a smaller amount",
						{ priceImpact: quote.priceImpact },
					);
				}
				const tgbpHeld = await deps.rpc.tokenBalance(owner, tgbp.mint);
				if (tgbpHeld < BigInt(quote.maxInAmount)) {
					throw new ApiError(
						422,
						"insufficient_balance",
						"The wallet does not hold enough tGBP for this payment",
						{ needed: quote.maxInAmount, held: tgbpHeld.toString(), decimals: tgbp.decimals },
					);
				}
				const tx = await deps.jupiter.swapTransaction({ quote, userPublicKey: owner });
				return {
					status: "ready" as const,
					provider: "jupiter" as const,
					transaction: tx.transaction,
					inputAsset: "TGBP" as const,
					inputMint: tgbp.mint,
					inputDecimals: tgbp.decimals,
					inputAmount: quote.inAmount,
					inputMaxAmount: quote.maxInAmount,
					outputMint: usdc.mint,
					outputDecimals: usdc.decimals,
					outputAmount: quote.outAmount,
					requiredAmount: required.toString(),
					heldAmount: held.toString(),
					slippageBps: quote.slippageBps,
					priceImpact: quote.priceImpact,
					route: quote.route,
				};
			} catch (e) {
				if (e instanceof JupiterError) {
					throw new ApiError(
						e.code === "no_route" ? 422 : 502,
						e.code === "no_route" ? "swap_no_route" : "swap_unavailable",
						e.message,
					);
				}
				throw e;
			}
		},
	}),
	defineRoute({
		method: "post",
		path: "/v1/payments/{id}/solana-swap/confirm",
		summary: "Check the sender's swap landed and the wallet now holds the payout USDC",
		auth: "customer",
		body: SolanaSwapConfirmRequestSchema,
		success: { status: 200, schema: SolanaSwapConfirmResponseSchema },
		handler: async (ctx, { params, body }) => {
			const owner = wallet(body.walletAddress);
			const { usdc, required } = await requiredUsdc(ctx, params.id!);
			const deps = swapDeps();
			const status = await deps.rpc.signatureStatus(body.signature);
			if (status === "failed") {
				throw new ApiError(
					422,
					"swap_failed",
					"The swap failed on Solana; nothing was swapped. Try again.",
				);
			}
			const held = await deps.rpc.tokenBalance(owner, usdc.mint);
			if (status === "confirmed" && held < required) {
				throw new ApiError(
					409,
					"swap_short",
					"The swap landed but the wallet still holds less USDC than the payout needs",
					{ held: held.toString(), required: required.toString() },
				);
			}
			return {
				status,
				signature: body.signature,
				heldAmount: held.toString(),
				requiredAmount: required.toString(),
			};
		},
	}),
];
