import { type ReactNode } from "react"

export interface PanelProps {
	title?: ReactNode
	description?: ReactNode
	actions?: ReactNode
	footer?: ReactNode
	children: ReactNode
}

export function Panel({
	title,
	description,
	actions,
	footer,
	children,
}: PanelProps) {
	return (
		<section className="panel">
			{title || description || actions ? (
				<header className="panel__header">
					<div>
						{title ? <h3 className="panel__title">{title}</h3> : null}
						{description ? (
							<p className="panel__description">{description}</p>
						) : null}
					</div>
					{actions ? <div className="panel__actions">{actions}</div> : null}
				</header>
			) : null}
			<div className="panel__body">{children}</div>
			{footer ? <footer className="panel__footer">{footer}</footer> : null}
		</section>
	)
}
