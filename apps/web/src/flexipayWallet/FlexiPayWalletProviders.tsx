import {
	CrossmintAuthProvider,
	CrossmintProvider,
	CrossmintWalletProvider,
} from "@crossmint/client-sdk-react-ui"
import { type ReactNode } from "react"
import { FLEXIPAY_WALLET_CREATE_ON_LOGIN } from "./config"

type Props = {
	apiKey: string
	children: ReactNode
}

/**
 * Staging Crossmint providers for the optional FlexiPay embedded Solana wallet.
 * Email OTP auth + wallet create/load on login (client key only).
 */
export function FlexiPayWalletProviders({ apiKey, children }: Props) {
	return (
		<CrossmintProvider apiKey={apiKey}>
			<CrossmintAuthProvider loginMethods={["email"]}>
				<CrossmintWalletProvider
					createOnLogin={FLEXIPAY_WALLET_CREATE_ON_LOGIN}
				>
					{children}
				</CrossmintWalletProvider>
			</CrossmintAuthProvider>
		</CrossmintProvider>
	)
}
