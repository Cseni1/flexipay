import { type ReactNode } from "react"
import { useLiveMoney } from "../../live/LiveMoney"

export interface SimulatedLabelProps {
	children?: ReactNode
}

export function SimulatedLabel({
	children = "Simulated",
}: SimulatedLabelProps) {
	const live = useLiveMoney()
	if (live) return null
	return (
		<span className="simulated-label" data-simulated="true">
			{children}
		</span>
	)
}
