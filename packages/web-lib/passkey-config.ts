// Public configuration for creating a passkey smart wallet from the browser (CCR-20, E3).
//
// Nothing here is a secret: the passkey never leaves the authenticator, the deployer keypair is
// the public deterministic deployer inside passkey-kit, and the API pays for the deploy with its
// own server-side FP_PAYER_DEMO_* key. Only public network values and the pinned WASM hash cross
// into the browser bundle.
import { networkPassphrase, rpcUrl } from "./env"

/**
 * Smart-wallet WASM hash pinned by CCR-20 (passkey-kit@0.19.1). The backend rejects any other
 * hash, so the browser must build the deploy carrier with exactly this value.
 */
export const PASSKEY_WALLET_WASM_HASH =
	"97ce047884106b1c6c3bb40b8973cc48db1c4dad95c9e20462bf2c701daa764e"

/**
 * WebAuthn relying-party labels. `userName` is stored by the authenticator, so it stays generic:
 * no claim token, payment id or personal data is ever written into a passkey.
 */
export const PASSKEY_WALLET_APP_NAME = "FlexiPay"
export const PASSKEY_WALLET_USER_NAME = "FlexiPay claim"

export interface PasskeyWalletConfig {
	rpcUrl: string
	networkPassphrase: string
	walletWasmHash: string
}

export const passkeyWalletConfig: PasskeyWalletConfig = {
	rpcUrl,
	networkPassphrase,
	walletWasmHash: PASSKEY_WALLET_WASM_HASH,
}

/**
 * The passkey deploy path needs a real public RPC origin and network passphrase. `env.ts` falls
 * back to localhost when they are missing, which would only produce a broken wallet creation, so
 * the UI stays explicitly unavailable instead of attempting it.
 */
export const isPasskeyWalletConfigured =
	Boolean(import.meta.env.PUBLIC_STELLAR_RPC_URL?.trim()) &&
	Boolean(import.meta.env.PUBLIC_STELLAR_NETWORK_PASSPHRASE?.trim())
