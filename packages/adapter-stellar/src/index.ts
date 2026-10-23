export { PayoutVault, VaultConfigMismatch } from "./vault-client.js";
export type { Payout, PayoutStatus, Receipt } from "./vault-client.js";
export { VAULT_ERRORS, VaultError, toVaultError } from "./vault-errors.js";
export type { VaultErrorCode, VaultErrorName } from "./vault-errors.js";
export { externalIdFor, newClaimSecret, claimHashOf, payoutAmounts } from "./vault-math.js";
export type { FeeMode } from "./vault-math.js";
export { loadStellarEnv, parseEnvFile } from "./stellar-env.js";
export type { StellarEnv } from "./stellar-env.js";

export { StellarSettlementAdapter } from "./settlement.js";
export type { StellarSettlementOptions } from "./settlement.js";

export {
	CustodialDemoWalletProvider,
	UnknownDemoWalletError,
} from "./demo-wallets.js";
export type { DemoWalletInfo, DemoWalletRole } from "./demo-wallets.js";

export {
	settlementModeFromEnv,
	createStellarSettlementAdapter,
	loadTestnetEnvFiles,
} from "./factory.js";
export type { SettlementMode, CreateStellarSettlementOptions } from "./factory.js";
