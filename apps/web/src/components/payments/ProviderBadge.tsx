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
