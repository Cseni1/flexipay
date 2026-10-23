import { type ReactNode } from "react"

export function Page({ children }: { children: ReactNode }) {
	return <div className="page">{children}</div>
}

export interface PageHeaderProps {
	eyebrow?: string
	title: string
	description?: ReactNode
	actions?: ReactNode
}

export function PageHeader({
	eyebrow,
	title,
	description,
	actions,
}: PageHeaderProps) {
	return (
		<header className="page-header">
			<div>
				{eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
				<h2 className="page-header__title">{title}</h2>
				{description ? (
					<p className="page-header__description">{description}</p>
				) : null}
			</div>
			{actions ? <div className="page-header__actions">{actions}</div> : null}
		</header>
	)
}

export function Grid({
	children,
	columns = 2,
}: {
	children: ReactNode
	columns?: 2 | 3
}) {
	return <div className={`grid grid--${columns}`}>{children}</div>
}

export function Notice({
	children,
	tone = "info",
}: {
	children: ReactNode
	tone?: "info" | "warning"
}) {
	return (
		<p className={`notice notice--${tone}`} role="note">
			{children}
		</p>
	)
}

export function EmptyState({
	title,
	children,
}: {
	title: string
	children?: ReactNode
}) {
	return (
		<div className="empty-state">
			<p className="empty-state__title">{title}</p>
			{children ? <p className="empty-state__body">{children}</p> : null}
		</div>
	)
}
