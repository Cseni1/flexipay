import {
	explorerUrlForSignature,
	loadSolanaRuntimeConfig,
	type SolanaRuntimeConfig,
} from "@flexipay/adapter-solana";

let cached: SolanaRuntimeConfig | null = null;

export function getSolanaRuntimeConfig(
	env: Record<string, string | undefined> = process.env,
): SolanaRuntimeConfig {
	if (!cached) cached = loadSolanaRuntimeConfig(env);
	return cached;
}

/** Test helper — clear memoised config between cases. */
export function resetSolanaRuntimeConfigCache(): void {
	cached = null;
}

export { explorerUrlForSignature };
