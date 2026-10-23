import { type ReactNode } from "react"

export interface SimulatedLabelProps {
	children?: ReactNode
}

export function SimulatedLabel({
	children = "Simulated",
}: SimulatedLabelProps) {
	return (
		<span className="simulated-label" data-simulated="true">
			{children}
		</span>
	)
}
