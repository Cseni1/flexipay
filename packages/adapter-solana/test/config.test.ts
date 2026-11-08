import { describe, expect, it } from "vitest";
import {
	DEFAULT_DEVNET_USDC_MINT,
	DEFAULT_TGBP_DECIMALS,
	loadSolanaRuntimeConfig,
	solanaAssetConfig,
} from "../src/config.ts";

const TGBP_MINT = "2zMqyX4AYCk6mgy5UZ2S7zUaLxwERhK5WjqDzkPPbSpW";

describe("CCR-26 settlement asset registry", () => {
	it("has USDC only by default and keeps the legacy usdc fields", () => {
		const cfg = loadSolanaRuntimeConfig({});
		expect(cfg.assets).toEqual([
			{ asset: "USDC", mint: DEFAULT_DEVNET_USDC_MINT, decimals: 6 },
		]);
		expect(cfg.usdcMint).toBe(DEFAULT_DEVNET_USDC_MINT);
		expect(cfg.usdcDecimals).toBe(6);
		expect(solanaAssetConfig(cfg, "TGBP")).toBeUndefined();
	});

	it("adds TGBP only when FP_SOLANA_TGBP_MINT is set, with default decimals", () => {
		const cfg = loadSolanaRuntimeConfig({ FP_SOLANA_TGBP_MINT: TGBP_MINT });
		expect(solanaAssetConfig(cfg, "TGBP")).toEqual({
			asset: "TGBP",
			mint: TGBP_MINT,
			decimals: DEFAULT_TGBP_DECIMALS,
		});
		expect(solanaAssetConfig(cfg, "USDC")?.mint).toBe(DEFAULT_DEVNET_USDC_MINT);
	});

	it("reads and validates FP_SOLANA_TGBP_DECIMALS", () => {
		const cfg = loadSolanaRuntimeConfig({
			FP_SOLANA_TGBP_MINT: TGBP_MINT,
			FP_SOLANA_TGBP_DECIMALS: "2",
		});
		expect(solanaAssetConfig(cfg, "TGBP")?.decimals).toBe(2);
		expect(() =>
			loadSolanaRuntimeConfig({
				FP_SOLANA_TGBP_MINT: TGBP_MINT,
				FP_SOLANA_TGBP_DECIMALS: "12",
			}),
		).toThrow(/FP_SOLANA_TGBP_DECIMALS/);
	});

	it("never configures TGBP on mainnet without FP_LIVE_MONEY=1", () => {
		expect(() =>
			loadSolanaRuntimeConfig({
				FP_SOLANA_CLUSTER: "mainnet-beta",
				FP_SOLANA_TGBP_MINT: TGBP_MINT,
			}),
		).toThrow(/FP_LIVE_MONEY=1/);
	});
});
