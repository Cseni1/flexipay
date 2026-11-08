import { useLiveMoney } from "../../live/LiveMoney"
import {
	providerBadge,
	type ProviderBadgeKind,
} from "../../payments/providerNames"

type Props = {
	simulated: boolean
	providerId: string
	"data-testid"?: string
}

export function ProviderBadge({
	simulated,
	providerId,
	"data-testid": testId = "provider-badge",
}: Props) {
	const live = useLiveMoney()
	const simulatedPartner =
		simulated ||
		providerId.endsWith("_sandbox") ||
		providerId.startsWith("sim_")
	if (live && simulatedPartner) return null
	const kind: ProviderBadgeKind = providerBadge(simulated, providerId)
	return (
		<span
			className={`provider-badge provider-badge--${kind.toLowerCase()}`}
			data-testid={testId}
		>
			{kind}
		</span>
	)
}
