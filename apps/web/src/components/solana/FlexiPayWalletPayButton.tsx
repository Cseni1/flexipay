import { useCrossmintAuth, useWallet } from "@crossmint/client-sdk-react-ui"
import { type FlexiPaySolanaWallet } from "../../flexipayWallet/sendFlexiPaySolanaTransaction"
import { Button } from "../ui"

type Props = {
	disabled?: boolean
	busy?: boolean
	label: string
	onPay: (wallet: FlexiPaySolanaWallet) => void
}

/**
 * Shows "Pay with FlexiPay wallet" only when Crossmint email wallet is signed in.
 * Must render under FlexiPayWalletProviders.
 */
export function FlexiPayWalletPayButton({
	disabled,
	busy,
	label,
	onPay,
}: Props) {
	const { status: authStatus } = useCrossmintAuth()
	const { wallet, status: walletStatus } = useWallet()
	const ready =
		authStatus === "logged-in" &&
		walletStatus === "loaded" &&
		Boolean(wallet?.address)

	if (!ready || !wallet) return null

	return (
		<Button
			type="button"
			variant="secondary"
			disabled={disabled || busy}
			onClick={() => onPay(wallet as FlexiPaySolanaWallet)}
			data-testid="solana-pay-flexipay"
		>
			{busy ? "Signing / confirming…" : label}
		</Button>
	)
}
