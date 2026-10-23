import { type ReactNode } from "react"

export interface TimelineItemProps {
	title: ReactNode
	status?: ReactNode
	meta?: ReactNode
	children?: ReactNode
}

export function TimelineItem({
	title,
	status,
	meta,
	children,
}: TimelineItemProps) {
	return (
		<li className="timeline__item">
			<span className="timeline__marker" aria-hidden="true" />
			<div className="timeline__body">
				<div className="timeline__heading">
					<strong className="timeline__title">{title}</strong>
					{status}
				</div>
				{meta ? <p className="timeline__meta">{meta}</p> : null}
				{children}
			</div>
		</li>
	)
}

export function Timeline({ children }: { children: ReactNode }) {
	return <ol className="timeline">{children}</ol>
}
