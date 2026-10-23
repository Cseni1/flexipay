export { PayoutVault, VaultConfigMismatch } from "./vault-client.ts";
export type { Payout, PayoutStatus, Receipt } from "./vault-client.ts";
export { VAULT_ERRORS, VaultError, toVaultError } from "./vault-errors.ts";
export type { VaultErrorCode, VaultErrorName } from "./vault-errors.ts";
export { externalIdFor, newClaimSecret, claimHashOf, payoutAmounts } from "./vault-math.ts";
export type { FeeMode } from "./vault-math.ts";
export { loadStellarEnv, parseEnvFile } from "./stellar-env.ts";
export type { StellarEnv } from "./stellar-env.ts";

export { StellarSettlementAdapter } from "./settlement.ts";
export type { StellarSettlementOptions } from "./settlement.ts";

export {
	CustodialDemoWalletProvider,
	UnknownDemoWalletError,
} from "./demo-wallets.ts";
export type { DemoWalletInfo, DemoWalletRole } from "./demo-wallets.ts";

export {
	settlementModeFromEnv,
	createStellarSettlementAdapter,
	loadTestnetEnvFiles,
} from "./factory.ts";
export type { SettlementMode, CreateStellarSettlementOptions } from "./factory.ts";
