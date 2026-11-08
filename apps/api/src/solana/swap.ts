// CCR-49: Jupiter swap (tGBP → USDC) inside the sender's own wallet, before a sender-wallet
// BlindPay payout. FlexiPay only fetches a quote and an unsigned transaction; it never signs,
// holds or moves the tokens.

import { JupiterClient, type JupiterExactOutQuote } from "@flexipay/adapters-live";
import { Connection, PublicKey } from "@solana/web3.js";
import { getSolanaRuntimeConfig } from "./runtime-config.ts";

export interface SwapRpc {
	/** Sum of the owner's token accounts for `mint`, base units. */
	tokenBalance(owner: string, mint: string): Promise<bigint>;
	signatureStatus(signature: string): Promise<"confirmed" | "pending" | "failed">;
}

export interface SwapQuoter {
	quoteExactOut(input: {
		inputMint: string;
		outputMint: string;
		amount: bigint;
		slippageBps: number;
	}): Promise<JupiterExactOutQuote>;
	swapTransaction(input: {
		quote: JupiterExactOutQuote;
		userPublicKey: string;
	}): Promise<{ transaction: string; lastValidBlockHeight: number | null }>;
}

export interface SwapDeps {
	rpc: SwapRpc;
	jupiter: SwapQuoter;
}

/** Slippage the sender accepts on the swap (0.5 %). */
export const SWAP_SLIPPAGE_BPS = 50;
/** A quote moving the price more than this (1 %) is refused. */
export const SWAP_MAX_PRICE_IMPACT = 0.01;

export function connectionSwapRpc(connection: Connection): SwapRpc {
	return {
		async tokenBalance(owner, mint) {
			const res = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), {
				mint: new PublicKey(mint),
			});
			let total = 0n;
			for (const acc of res.value) {
				const info = (acc.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } })
					.parsed?.info;
				const amount = info?.tokenAmount?.amount;
				if (typeof amount === "string" && /^\d+$/.test(amount)) total += BigInt(amount);
			}
			return total;
		},
		async signatureStatus(signature) {
			const res = await connection.getSignatureStatuses([signature], {
				searchTransactionHistory: true,
			});
			const status = res.value[0];
			if (!status) return "pending";
			if (status.err) return "failed";
			return status.confirmationStatus === "confirmed" ||
				status.confirmationStatus === "finalized"
				? "confirmed"
				: "pending";
		},
	};
}

let override: SwapDeps | null = null;

/** Test-only hook. Production code must not call this. */
export function setSwapDepsForTests(deps: SwapDeps | null): void {
	override = deps;
}

export function swapDeps(env: Record<string, string | undefined> = process.env): SwapDeps {
	if (override) return override;
	const cfg = getSolanaRuntimeConfig();
	return {
		rpc: connectionSwapRpc(new Connection(cfg.rpcUrl, "confirmed")),
		jupiter: new JupiterClient({ apiKey: env.JUPITER_API_KEY }),
	};
}

/** Swap input assets offered right now: tGBP on mainnet, unless FP_JUPITER_SWAP=0. */
export function swapInputAssets(env: Record<string, string | undefined> = process.env): "TGBP"[] {
	if (env.FP_JUPITER_SWAP?.trim() === "0") return [];
	const cfg = getSolanaRuntimeConfig();
	if (cfg.cluster !== "mainnet-beta") return [];
	return cfg.assets.some((a) => a.asset === "TGBP") ? ["TGBP"] : [];
}
