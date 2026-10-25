// Reads the public FP_ settings that scripts/testnet/setup.sh writes to testnet-ids.env
// (names listed in the root .env.example, CCR-1). Secrets are never read here.

import {
  parseSorobanTxFeeCeiling,
  SOROBAN_TX_FEE_CEILING_ENV,
} from "./vault-tx-fee.ts";

export interface StellarEnv {
  network: string;
  rpcUrl: string;
  networkPassphrase: string;
  usdcAsset: string;
  usdcContractId: string;
  payoutVaultId: string;
  vaultFeeBps: number;
  treasuryAddress: string;
  /**
   * Max total Soroban tx fee (inclusion + resource, once) in stroops.
   * From FP_SOROBAN_TX_FEE_CEILING_STROOPS. null when unset — vault writes fail typed
   * until Claude confirms a default; code never invents one.
   */
  sorobanTxFeeCeilingStroops: bigint | null;
}

const REQUIRED = {
  network: "FP_STELLAR_NETWORK",
  rpcUrl: "FP_STELLAR_RPC_URL",
  networkPassphrase: "FP_STELLAR_NETWORK_PASSPHRASE",
  usdcAsset: "FP_USDC_ASSET",
  usdcContractId: "FP_USDC_CONTRACT_ID",
  payoutVaultId: "FP_PAYOUT_VAULT_ID",
  vaultFeeBps: "FP_VAULT_FEE_BPS",
  treasuryAddress: "FP_TREASURY_ADDRESS",
} as const;

export function loadStellarEnv(env: Record<string, string | undefined> = process.env): StellarEnv {
  const missing = Object.values(REQUIRED).filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing Stellar settings: ${missing.join(", ")}`);
  }
  const get = (key: keyof typeof REQUIRED) => env[REQUIRED[key]] as string;
  const vaultFeeBps = Number(get("vaultFeeBps"));
  if (!Number.isInteger(vaultFeeBps) || vaultFeeBps < 0 || vaultFeeBps > 1000) {
    throw new Error(`FP_VAULT_FEE_BPS must be an integer from 0 to 1000, got ${get("vaultFeeBps")}`);
  }
  return {
    network: get("network"),
    rpcUrl: get("rpcUrl"),
    networkPassphrase: get("networkPassphrase"),
    usdcAsset: get("usdcAsset"),
    usdcContractId: get("usdcContractId"),
    payoutVaultId: get("payoutVaultId"),
    vaultFeeBps,
    treasuryAddress: get("treasuryAddress"),
    sorobanTxFeeCeilingStroops: parseSorobanTxFeeCeiling(env),
  };
}

export { SOROBAN_TX_FEE_CEILING_ENV };

/** Parses a KEY=value env file (comments, blank lines and surrounding quotes allowed). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}
