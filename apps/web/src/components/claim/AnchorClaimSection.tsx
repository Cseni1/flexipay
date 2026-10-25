import { type ClaimView } from "@flexipay/web-lib/claim-contract"
import { AnchorClaimPanel } from "./AnchorClaimPanel"
import { useAnchorClaim } from "./useAnchorClaim"

// One claim link, one anchor flow. Remounted per token by ClaimPage so a token change cannot
// inherit an anchor transaction id, a hosted URL or a polling interval from the previous claim.
export interface AnchorClaimSectionProps {
	token: string
	/** USDC major units for the indicative quote, or null when outside the 1–10 window. */
	quoteAmount: string | null
	claim: ClaimView
	claimExpired: boolean
	onUseCryptoWallet?: () => void
}

export function AnchorClaimSection({
	token,
	quoteAmount,
	claim,
	claimExpired,
	onUseCryptoWallet,
}: AnchorClaimSectionProps) {
	const { state, start, retry, pay, openHosted, reloadQuote } = useAnchorClaim({
		token,
		quoteAmount,
		claimExpired,
	})

	return (
		<AnchorClaimPanel
			state={state}
			claim={claim}
			claimExpired={claimExpired}
			onStart={start}
			onRetry={retry}
			onRetryQuote={reloadQuote}
			onPay={pay}
			onOpenHosted={openHosted}
			onUseCryptoWallet={onUseCryptoWallet}
		/>
	)
}
