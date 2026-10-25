// Public configuration for creating a passkey smart wallet from the browser (CCR-21, E3).
//
// Nothing here is a secret: the passkey never leaves the authenticator, the deployer keypair is
// the public deterministic deployer inside passkey-kit, and the API pays for the deploy with its
// own server-side FP_PAYER_DEMO_* key. Only public network values and the pinned WASM hash cross
// into the browser bundle.
//
// The values come from the repo's FP_ config, exposed explicitly in apps/web/vite.config.ts:
// FP_STELLAR_RPC_URL and FP_STELLAR_NETWORK_PASSPHRASE. There is no FP_ envPrefix, so no other
// FP_ value (FP_API_KEY, FP_*_SECRET) reaches the browser.

/**
 * Smart-wallet WASM hash pinned by CCR-21 (passkey-kit@0.19.1). The backend rejects any other
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

const publicRpcUrl = import.meta.env.FP_STELLAR_RPC_URL?.trim() ?? ""
const publicNetworkPassphrase =
	import.meta.env.FP_STELLAR_NETWORK_PASSPHRASE?.trim() ?? ""

export const passkeyWalletConfig: PasskeyWalletConfig = {
	rpcUrl: publicRpcUrl,
	networkPassphrase: publicNetworkPassphrase,
	walletWasmHash: PASSKEY_WALLET_WASM_HASH,
}

/**
 * The passkey path needs a real public RPC origin and network passphrase. Without them the UI
 * stays explicitly unavailable instead of attempting a broken wallet creation.
 */
export const isPasskeyWalletConfigured =
	Boolean(publicRpcUrl) && Boolean(publicNetworkPassphrase)
