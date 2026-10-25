import { type ClaimView } from "@flexipay/web-lib/claim-contract"
import { AnchorClaimPanel } from "./AnchorClaimPanel"
import { useAnchorClaim } from "./useAnchorClaim"

// One claim link, one anchor flow. Remounted per token by ClaimPage so a token change cannot
// inherit an anchor transaction id or a polling interval from the previous claim.
export interface AnchorClaimSectionProps {
	token: string
	sellAmount: string
	claim: ClaimView
	claimExpired: boolean
	onUseCryptoWallet?: () => void
}

export function AnchorClaimSection({
	token,
	sellAmount,
	claim,
	claimExpired,
	onUseCryptoWallet,
}: AnchorClaimSectionProps) {
	const { state, start, retry } = useAnchorClaim({
		token,
		sellAmount,
		claimExpired,
	})

	return (
		<AnchorClaimPanel
			state={state}
			claim={claim}
			claimExpired={claimExpired}
			onStart={start}
			onRetry={retry}
			onUseCryptoWallet={onUseCryptoWallet}
		/>
	)
}
