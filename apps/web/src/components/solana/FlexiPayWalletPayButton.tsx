import { usePrivy } from "@privy-io/react-auth"
import {
	useSignAndSendTransaction,
	useWallets,
} from "@privy-io/react-auth/solana"
import bs58 from "bs58"
import { FLEXIPAY_WALLET_CHAIN } from "../../flexipayWallet/config"
import { type FlexiPaySolanaWallet } from "../../flexipayWallet/sendFlexiPaySolanaTransaction"
import { Button } from "../ui"

type Props = {
	disabled?: boolean
	busy?: boolean
	label: string
	onPay: (wallet: FlexiPaySolanaWallet) => void
}

/**
 * Shows "Pay with FlexiPay wallet" only when the Privy embedded wallet is signed in.
 * Must render under FlexiPayWalletProviders.
 */
export function FlexiPayWalletPayButton({
	disabled,
	busy,
	label,
	onPay,
}: Props) {
	const { ready, authenticated } = usePrivy()
	const { wallets, ready: walletsReady } = useWallets()
	const { signAndSendTransaction } = useSignAndSendTransaction()
	const wallet = wallets[0]
	if (!ready || !authenticated || !walletsReady || !wallet?.address) return null

	const flexiWallet: FlexiPaySolanaWallet = {
		address: wallet.address,
		sendTransaction: async ({ serializedTransaction }) => {
			const { signature } = await signAndSendTransaction({
				transaction: bs58.decode(serializedTransaction),
				wallet,
				chain: FLEXIPAY_WALLET_CHAIN,
			})
			return { hash: bs58.encode(signature) }
		},
	}

	return (
		<Button
			type="button"
			variant="secondary"
			disabled={disabled || busy}
			onClick={() => onPay(flexiWallet)}
			data-testid="solana-pay-flexipay"
		>
			{busy ? "Signing / confirming…" : label}
		</Button>
	)
}
