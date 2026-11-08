export type SolanaCluster = "devnet" | "testnet" | "mainnet-beta";

/** Circle's historical Solana Devnet USDC mint (test asset — not mainnet USDC). */
export const DEFAULT_DEVNET_USDC_MINT =
	"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** Circle's Solana mainnet USDC mint. Used only when FP_LIVE_MONEY=1. */
export const DEFAULT_MAINNET_USDC_MINT =
	"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const DEFAULT_USDC_DECIMALS = 6;

/** Settlement assets FlexiPay can verify on Solana (CCR-26). */
export type SolanaSettlementAsset = "USDC" | "TGBP";

/**
 * Default decimals for the tGBP SPL mint when FP_SOLANA_TGBP_DECIMALS is unset.
 * UNCONFIRMED with the issuer (Tokenised GBP): the website does not state them.
 * Confirm with the issuer before any mainnet use; never rely on this default there.
 */
export const DEFAULT_TGBP_DECIMALS = 6;

export interface SolanaAssetConfig {
	asset: SolanaSettlementAsset;
	mint: string;
	decimals: number;
}

export interface SolanaRuntimeConfig {
	/** Settlement assets registry: USDC always; TGBP only when FP_SOLANA_TGBP_MINT is set. */
	assets: SolanaAssetConfig[];
	cluster: SolanaCluster;
	rpcUrl: string;
	usdcMint: string;
	usdcDecimals: number;
	explorerTxUrlTemplate: string;
	label: string;
	publicRpcUrl?: string;
}

export function solanaClusterFromEnv(
	env: Record<string, string | undefined> = process.env,
): SolanaCluster {
	const raw = (env.FP_SOLANA_CLUSTER ?? "devnet").trim();
	if (raw === "devnet" || raw === "testnet" || raw === "mainnet-beta") {
		return raw;
	}
	throw new Error(
		`FP_SOLANA_CLUSTER must be devnet|testnet|mainnet-beta, got ${JSON.stringify(raw)}`,
	);
}

export function loadSolanaRuntimeConfig(
	env: Record<string, string | undefined> = process.env,
): SolanaRuntimeConfig {
	const cluster = solanaClusterFromEnv(env);
	if (cluster === "mainnet-beta" && env.FP_LIVE_MONEY !== "1") {
		throw new Error(
			"FP_SOLANA_CLUSTER=mainnet-beta requires FP_LIVE_MONEY=1; refusing to start",
		);
	}
	const rpcUrl =
		env.FP_SOLANA_RPC_URL?.trim() ||
		(cluster === "devnet"
			? "https://api.devnet.solana.com"
			: cluster === "testnet"
				? "https://api.testnet.solana.com"
				: "https://api.mainnet-beta.solana.com");
	const usdcMint =
		env.FP_SOLANA_USDC_MINT?.trim() ||
		(cluster === "devnet"
			? DEFAULT_DEVNET_USDC_MINT
			: cluster === "mainnet-beta"
				? DEFAULT_MAINNET_USDC_MINT
				: "");
	if (!usdcMint) {
		throw new Error("FP_SOLANA_USDC_MINT is required for this Solana cluster");
	}
	const decimalsRaw = env.FP_SOLANA_USDC_DECIMALS?.trim();
	const usdcDecimals = decimalsRaw
		? Number(decimalsRaw)
		: DEFAULT_USDC_DECIMALS;
	if (!Number.isInteger(usdcDecimals) || usdcDecimals < 0 || usdcDecimals > 9) {
		throw new Error("FP_SOLANA_USDC_DECIMALS must be an integer 0–9");
	}
	const assets: SolanaAssetConfig[] = [
		{ asset: "USDC", mint: usdcMint, decimals: usdcDecimals },
	];
	const tgbpMint = env.FP_SOLANA_TGBP_MINT?.trim();
	if (tgbpMint) {
		const tgbpRaw = env.FP_SOLANA_TGBP_DECIMALS?.trim();
		const tgbpDecimals = tgbpRaw ? Number(tgbpRaw) : DEFAULT_TGBP_DECIMALS;
		if (!Number.isInteger(tgbpDecimals) || tgbpDecimals < 0 || tgbpDecimals > 9) {
			throw new Error("FP_SOLANA_TGBP_DECIMALS must be an integer 0–9");
		}
		assets.push({ asset: "TGBP", mint: tgbpMint, decimals: tgbpDecimals });
	}
	const explorerTxUrlTemplate =
		env.FP_SOLANA_EXPLORER_TX_URL?.trim() ||
		`https://explorer.solana.com/tx/{signature}?cluster=${cluster}`;
	const label =
		cluster === "mainnet-beta"
			? "Solana USDC"
			: `Solana ${cluster} USDC (test — not mainnet)`;
	const publicRpcUrl = env.FP_SOLANA_PUBLIC_RPC_URL?.trim() || undefined;
	return {
		assets,
		cluster,
		rpcUrl,
		usdcMint,
		usdcDecimals,
		explorerTxUrlTemplate,
		label,
		publicRpcUrl,
	};
}

export function explorerUrlForSignature(
	template: string,
	signature: string,
): string {
	return template.replaceAll("{signature}", signature);
}

/** The configured settlement asset for a FlexiPay currency code, or undefined when unsupported/unconfigured. */
export function solanaAssetConfig(
	cfg: Pick<SolanaRuntimeConfig, "assets">,
	currency: string,
): SolanaAssetConfig | undefined {
	return cfg.assets.find((a) => a.asset === currency);
}
