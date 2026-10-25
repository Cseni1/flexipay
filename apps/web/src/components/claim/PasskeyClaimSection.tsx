import { PasskeyClaimPanel } from "./PasskeyClaimPanel"
import { usePasskeyClaim } from "./usePasskeyClaim"

// Owns the passkey deploy flow for one claim link. Kept separate from ClaimPage so the
// G-address claim flow keeps its own state and a token change cannot reuse a stored deploy
// carrier: the section is remounted per token by the page.
export interface PasskeyClaimSectionProps {
	token: string
	claimExpired: boolean
	claimClosed: boolean
	onUseCryptoWallet: () => void
}

export function PasskeyClaimSection({
	token,
	claimExpired,
	claimClosed,
	onUseCryptoWallet,
}: PasskeyClaimSectionProps) {
	const { flow, create, retry, cancel } = usePasskeyClaim({ token })

	return (
		<PasskeyClaimPanel
			flow={flow}
			claimExpired={claimExpired}
			claimClosed={claimClosed}
			onCreate={create}
			onRetry={retry}
			onCancel={cancel}
			onUseCryptoWallet={onUseCryptoWallet}
		/>
	)
}
