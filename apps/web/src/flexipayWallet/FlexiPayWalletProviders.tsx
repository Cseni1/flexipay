import { PrivyProvider } from "@privy-io/react-auth"
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit"
import { type ReactNode } from "react"

type Props = {
	appId: string
	children: ReactNode
}

const DEVNET_RPC = "https://api.devnet.solana.com"
const DEVNET_WS = "wss://api.devnet.solana.com"

/**
 * Privy providers for the FlexiPay embedded Solana wallet: email or passkey login,
 * a Solana wallet created on first login, devnet only.
 */
export function FlexiPayWalletProviders({ appId, children }: Props) {
	return (
		<PrivyProvider
			appId={appId}
			config={{
				loginMethods: ["email", "passkey"],
				appearance: { walletChainType: "solana-only" },
				embeddedWallets: {
					solana: { createOnLogin: "users-without-wallets" },
					ethereum: { createOnLogin: "off" },
				},
				solana: {
					rpcs: {
						"solana:devnet": {
							rpc: createSolanaRpc(DEVNET_RPC),
							rpcSubscriptions: createSolanaRpcSubscriptions(DEVNET_WS),
						},
					},
				},
			}}
		>
			{children}
		</PrivyProvider>
	)
}
