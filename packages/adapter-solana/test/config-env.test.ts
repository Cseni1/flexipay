import { describe, expect, it } from "vitest";
import {
	DEFAULT_DEVNET_USDC_MINT,
	explorerUrlForSignature,
	loadSolanaRuntimeConfig,
	solanaClusterFromEnv,
} from "../src/config.ts";
import * as server from "../src/server.ts";
import * as root from "../src/index.ts";

const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("solanaClusterFromEnv", () => {
	it("defaults to devnet and trims", () => {
		expect(solanaClusterFromEnv({})).toBe("devnet");
		expect(solanaClusterFromEnv({ FP_SOLANA_CLUSTER: " testnet " })).toBe("testnet");
		expect(solanaClusterFromEnv({ FP_SOLANA_CLUSTER: "mainnet-beta" })).toBe("mainnet-beta");
	});

	it("rejects unknown clusters", () => {
		expect(() => solanaClusterFromEnv({ FP_SOLANA_CLUSTER: "mainnet" })).toThrow(
			/devnet\|testnet\|mainnet-beta/,
		);
		expect(() => solanaClusterFromEnv({ FP_SOLANA_CLUSTER: "" })).toThrow(/FP_SOLANA_CLUSTER/);
	});
});

describe("loadSolanaRuntimeConfig", () => {
	it("devnet defaults", () => {
		const cfg = loadSolanaRuntimeConfig({});
		expect(cfg.cluster).toBe("devnet");
		expect(cfg.rpcUrl).toBe("https://api.devnet.solana.com");
		expect(cfg.usdcMint).toBe(DEFAULT_DEVNET_USDC_MINT);
		expect(cfg.explorerTxUrlTemplate).toBe(
			"https://explorer.solana.com/tx/{signature}?cluster=devnet",
		);
		expect(cfg.label).toMatch(/devnet.*not mainnet/);
		expect(cfg.publicRpcUrl).toBeUndefined();
	});

	it("testnet requires an explicit USDC mint", () => {
		expect(() => loadSolanaRuntimeConfig({ FP_SOLANA_CLUSTER: "testnet" })).toThrow(
			/FP_SOLANA_USDC_MINT is required/,
		);
		const cfg = loadSolanaRuntimeConfig({
			FP_SOLANA_CLUSTER: "testnet",
			FP_SOLANA_USDC_MINT: ` ${DEFAULT_DEVNET_USDC_MINT} `,
		});
		expect(cfg.rpcUrl).toBe("https://api.testnet.solana.com");
		expect(cfg.usdcMint).toBe(DEFAULT_DEVNET_USDC_MINT);
		expect(cfg.label).toMatch(/testnet/);
	});

	it("mainnet guard: blocked without approval, approval other than '1' still blocked", () => {
		expect(() => loadSolanaRuntimeConfig({ FP_SOLANA_CLUSTER: "mainnet-beta" })).toThrow(
			/FP_SOLANA_MAINNET_APPROVED=1/,
		);
		expect(() =>
			loadSolanaRuntimeConfig({
				FP_SOLANA_CLUSTER: "mainnet-beta",
				FP_SOLANA_MAINNET_APPROVED: "true",
				FP_SOLANA_USDC_MINT: MAINNET_USDC,
			}),
		).toThrow(/explicit approval/);
	});

	it("mainnet with approval still has no default USDC mint", () => {
		expect(() =>
			loadSolanaRuntimeConfig({
				FP_SOLANA_CLUSTER: "mainnet-beta",
				FP_SOLANA_MAINNET_APPROVED: "1",
			}),
		).toThrow(/FP_SOLANA_USDC_MINT is required/);
	});

	it("mainnet with approval and mint", () => {
		const cfg = loadSolanaRuntimeConfig({
			FP_SOLANA_CLUSTER: "mainnet-beta",
			FP_SOLANA_MAINNET_APPROVED: "1",
			FP_SOLANA_USDC_MINT: MAINNET_USDC,
		});
		expect(cfg.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
		expect(cfg.label).toBe("Solana USDC");
		expect(cfg.assets).toEqual([{ asset: "USDC", mint: MAINNET_USDC, decimals: 6 }]);
	});

	it("honours RPC / public RPC / explorer overrides; blank values fall back", () => {
		const cfg = loadSolanaRuntimeConfig({
			FP_SOLANA_RPC_URL: "https://rpc.example/devnet",
			FP_SOLANA_PUBLIC_RPC_URL: "https://public.example",
			FP_SOLANA_EXPLORER_TX_URL: "https://solscan.io/tx/{signature}",
		});
		expect(cfg.rpcUrl).toBe("https://rpc.example/devnet");
		expect(cfg.publicRpcUrl).toBe("https://public.example");
		expect(cfg.explorerTxUrlTemplate).toBe("https://solscan.io/tx/{signature}");
		const blank = loadSolanaRuntimeConfig({
			FP_SOLANA_RPC_URL: "  ",
			FP_SOLANA_PUBLIC_RPC_URL: " ",
			FP_SOLANA_TGBP_MINT: " ",
		});
		expect(blank.rpcUrl).toBe("https://api.devnet.solana.com");
		expect(blank.publicRpcUrl).toBeUndefined();
		expect(blank.assets).toHaveLength(1);
	});

	it("USDC decimals: reads override, rejects non-integer / out of range", () => {
		expect(loadSolanaRuntimeConfig({ FP_SOLANA_USDC_DECIMALS: "7" }).usdcDecimals).toBe(7);
		expect(loadSolanaRuntimeConfig({ FP_SOLANA_USDC_DECIMALS: "0" }).usdcDecimals).toBe(0);
		for (const bad of ["10", "-1", "6.5", "six"]) {
			expect(() => loadSolanaRuntimeConfig({ FP_SOLANA_USDC_DECIMALS: bad })).toThrow(
				/FP_SOLANA_USDC_DECIMALS/,
			);
		}
	});

	it("tGBP decimals: rejects non-integer, accepts 0", () => {
		const TGBP = "2zMqyX4AYCk6mgy5UZ2S7zUaLxwERhK5WjqDzkPPbSpW";
		expect(() =>
			loadSolanaRuntimeConfig({ FP_SOLANA_TGBP_MINT: TGBP, FP_SOLANA_TGBP_DECIMALS: "x" }),
		).toThrow(/FP_SOLANA_TGBP_DECIMALS/);
		const cfg = loadSolanaRuntimeConfig({
			FP_SOLANA_TGBP_MINT: TGBP,
			FP_SOLANA_TGBP_DECIMALS: "0",
		});
		expect(cfg.assets[1]).toEqual({ asset: "TGBP", mint: TGBP, decimals: 0 });
	});

	it("tGBP on approved mainnet is configured only from env", () => {
		const TGBP = "2zMqyX4AYCk6mgy5UZ2S7zUaLxwERhK5WjqDzkPPbSpW";
		const cfg = loadSolanaRuntimeConfig({
			FP_SOLANA_CLUSTER: "mainnet-beta",
			FP_SOLANA_MAINNET_APPROVED: "1",
			FP_SOLANA_USDC_MINT: MAINNET_USDC,
			FP_SOLANA_TGBP_MINT: TGBP,
			FP_SOLANA_TGBP_DECIMALS: "2",
		});
		expect(cfg.assets.map((a) => a.asset)).toEqual(["USDC", "TGBP"]);
	});
});

describe("explorerUrlForSignature", () => {
	it("replaces every {signature} placeholder", () => {
		expect(explorerUrlForSignature("a/{signature}/b/{signature}", "SIG")).toBe("a/SIG/b/SIG");
		expect(explorerUrlForSignature("no-placeholder", "SIG")).toBe("no-placeholder");
	});
});

describe("entry points", () => {
	it("index re-exports the server surface", () => {
		expect(root.verifyUsdcTransfer).toBe(server.verifyUsdcTransfer);
		expect(typeof server.buildUsdcTransferTransaction).toBe("function");
		expect(typeof server.loadSolanaRuntimeConfig).toBe("function");
	});
});
