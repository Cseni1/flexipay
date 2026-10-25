/**
 * Pins for passkey-kit@0.19.1 shared-deployer wallet deploys (CCR-20).
 * Do not change without a matching kit / WASM upgrade and CCR update.
 */

/** passkey-kit DEFAULT_DEPLOYER_SEED — public, deterministic address salt only. */
export const PASSKEY_DEFAULT_DEPLOYER_SEED = "kalepail";

/**
 * Smart-wallet WASM hash pinned in CCR-20 / EVENT_PLAN E2.
 * Lowercase hex, 64 chars.
 */
export const PASSKEY_WALLET_WASM_HASH =
	"97ce047884106b1c6c3bb40b8973cc48db1c4dad95c9e20462bf2c701daa764e";
