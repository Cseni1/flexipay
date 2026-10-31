export type SolanaCluster = "devnet" | "testnet" | "mainnet-beta";

/** Circle's historical Solana Devnet USDC mint (test asset — not mainnet USDC). */
export const DEFAULT_DEVNET_USDC_MINT =
	"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export const DEFAULT_USDC_DECIMALS = 6;

export interface SolanaRuntimeConfig {
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
	if (cluster === "mainnet-beta" && env.FP_SOLANA_MAINNET_APPROVED !== "1") {
		throw new Error(
			"mainnet-beta Solana requires separate explicit approval (FP_SOLANA_MAINNET_APPROVED=1)",
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
		(cluster === "devnet" ? DEFAULT_DEVNET_USDC_MINT : "");
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
	const explorerTxUrlTemplate =
		env.FP_SOLANA_EXPLORER_TX_URL?.trim() ||
		`https://explorer.solana.com/tx/{signature}?cluster=${cluster}`;
	const label =
		cluster === "mainnet-beta"
			? "Solana USDC"
			: `Solana ${cluster} USDC (test — not mainnet)`;
	const publicRpcUrl = env.FP_SOLANA_PUBLIC_RPC_URL?.trim() || undefined;
	return {
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
