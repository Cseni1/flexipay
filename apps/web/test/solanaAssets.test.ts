import { describe, expect, it } from "vitest"
import { parseSolanaConfig, parseSolanaIntent } from "../src/api/solanaClient"
import {
	assetLabel,
	formatAssetAmount,
	preferredAssetFromConfig,
} from "../src/solana/assets"

describe("assetLabel", () => {
	it("labels TGBP as pounds and USDC as USDC", () => {
		expect(assetLabel("TGBP")).toBe("tGBP (£)")
		expect(assetLabel("USDC")).toBe("USDC")
	})
})

describe("formatAssetAmount", () => {
	it("formats TGBP as GBP with 2 decimals", () => {
		// 12.50 GBP at 6 mint decimals
		expect(formatAssetAmount("TGBP", "12500000", 6)).toBe("£12.50")
	})

	it("formats USDC as a plain major amount", () => {
		expect(formatAssetAmount("USDC", "1250000", 6)).toMatch(/1\.25/)
	})
})

describe("preferredAssetFromConfig", () => {
	it("prefers TGBP when listed", () => {
		expect(
			preferredAssetFromConfig(
				[
					{ asset: "USDC", mint: "UsdcMint111", decimals: 6 },
					{ asset: "TGBP", mint: "TgbpMint111", decimals: 6 },
				],
				{ mint: "UsdcMint111", decimals: 6 },
			).asset,
		).toBe("TGBP")
	})

	it("falls back to USDC when TGBP is absent", () => {
		expect(
			preferredAssetFromConfig(
				[{ asset: "USDC", mint: "UsdcMint111", decimals: 6 }],
				{ mint: "UsdcMint111", decimals: 6 },
			).asset,
		).toBe("USDC")
	})
})

describe("parseSolanaConfig / parseSolanaIntent", () => {
	it("synthesizes assets when the config omits them", () => {
		const cfg = parseSolanaConfig({
			cluster: "devnet",
			usdcMint: "UsdcMintLegacy111111111111111111111111",
			usdcDecimals: 6,
			explorerTxUrlTemplate: "https://explorer.solana.com/tx/{signature}",
			publicRpcUrl: null,
			label: "Solana USDC (devnet)",
		})
		expect(cfg.assets).toEqual([
			{
				asset: "USDC",
				mint: "UsdcMintLegacy111111111111111111111111",
				decimals: 6,
			},
		])
	})

	it("defaults a legacy intent without asset to USDC", () => {
		const intent = parseSolanaIntent({
			paymentId: "pay_1",
			cluster: "devnet",
			usdcMint: "UsdcMintLegacy111111111111111111111111",
			usdcDecimals: 6,
			amount: "1000000",
			recipient: "Recipient111111111111111111111111111111",
			reference: "Reference11111111111111111111111111111",
			intentIssuedAt: "2026-11-04T12:00:00.000Z",
			label: "Pay USDC",
			explorerTxUrlTemplate: "https://explorer.solana.com/tx/{signature}",
		})
		expect(intent.asset).toBe("USDC")
		expect(intent.mint).toBe("UsdcMintLegacy111111111111111111111111")
		expect(intent.decimals).toBe(6)
	})

	it("keeps TGBP mint and decimals from a CCR-26 intent", () => {
		const intent = parseSolanaIntent({
			paymentId: "pay_tgbp",
			cluster: "devnet",
			asset: "TGBP",
			mint: "TgbpMint111111111111111111111111111111",
			decimals: 6,
			usdcMint: "TgbpMint111111111111111111111111111111",
			usdcDecimals: 6,
			amount: "2500000",
			recipient: "Recipient111111111111111111111111111111",
			reference: "Reference11111111111111111111111111111",
			intentIssuedAt: "2026-11-04T12:00:00.000Z",
			label: "Pay tGBP",
			explorerTxUrlTemplate: "https://explorer.solana.com/tx/{signature}",
		})
		expect(intent.asset).toBe("TGBP")
		expect(intent.mint).toBe("TgbpMint111111111111111111111111111111")
		expect(intent.decimals).toBe(6)
		expect(
			formatAssetAmount(intent.asset, intent.amount, intent.decimals),
		).toBe("£2.50")
	})
})
