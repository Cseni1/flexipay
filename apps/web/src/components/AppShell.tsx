import { useEffect, useState } from "react"
import { Link, NavLink, Outlet, useLocation } from "react-router-dom"
import { useTheme } from "../hooks/useTheme"
import { useLiveMoney } from "../live/LiveMoney"
import { useSession } from "../providers/SessionProvider"
import { ApiStatus } from "./ApiStatus"
import { InfoPopover, SimulatedLabel } from "./ui"
import { Icon, type IconName } from "./ui/Icon"

type NavItem = { to: string; label: string; icon: IconName; end?: boolean }

/** The four things people do most. Everything else sits under "More". */
const PRIMARY: NavItem[] = [
	{ to: "/dashboard", label: "Home", icon: "home" },
	{ to: "/", label: "Send money", icon: "send", end: true },
	{ to: "/payments", label: "Activity", icon: "activity", end: true },
	{ to: "/recipients", label: "People", icon: "people" },
	{ to: "/take-payment", label: "Get paid", icon: "request" },
]

const MORE: NavItem[] = [
	{ to: "/wallet", label: "Connected wallet", icon: "wallet" },
	{ to: "/pay-from", label: "Pay from", icon: "card" },
	{ to: "/where-we-pay", label: "Where we pay", icon: "globe" },
	{ to: "/developers", label: "Developers", icon: "code" },
	{ to: "/account", label: "Account", icon: "user" },
]

/** Bottom tabs on phones: Send sits in the middle as the big button. */
const TABS: NavItem[] = [
	{ to: "/dashboard", label: "Home", icon: "home" },
	{ to: "/payments", label: "Activity", icon: "activity", end: true },
	{ to: "/", label: "Send", icon: "send", end: true },
	{ to: "/recipients", label: "People", icon: "people" },
]

function NavLinkItem({ item }: { item: NavItem }) {
	return (
		<NavLink to={item.to} end={item.end} className="nav-link">
			<Icon name={item.icon} className="nav-link__icon" />
			<span>{item.label}</span>
		</NavLink>
	)
}

export function AppShell() {
	const { state, logout } = useSession()
	const { cycle, label } = useTheme()
	const live = useLiveMoney()
	const location = useLocation()
	const [moreOpen, setMoreOpen] = useState(false)
	const user = state.status === "signed_in" ? state.session.user : null

	useEffect(() => {
		setMoreOpen(false)
	}, [location.pathname])

	return (
		<div className="app-shell">
			<aside className="app-sidebar">
				<Link to="/dashboard" className="app-brand">
					<span className="app-brand__mark" aria-hidden="true">
						<Icon name="bolt" size={18} />
					</span>
					<span className="app-brand__text">
						<h1 className="app-brand__name">FlexiPay</h1>
						<span className="app-brand__by">by FlexiWork</span>
					</span>
				</Link>

				<nav className="app-nav" aria-label="Primary">
					{PRIMARY.map((item) => (
						<NavLinkItem key={item.to} item={item} />
					))}
					<p className="app-nav__group">More</p>
					{MORE.map((item) => (
						<NavLinkItem key={item.to} item={item} />
					))}
				</nav>

				{state.status === "unconfigured" ? (
					<div className="app-sidebar__footer">
						<Link to="/login" className="nav-link">
							<Icon name="user" className="nav-link__icon" />
							Sign in
						</Link>
					</div>
				) : null}

				<div className="app-sidebar__footer">
					<ApiStatus />
					{user ? (
						<div className="session-box" data-testid="session-box">
							<span className="session-box__avatar" aria-hidden="true">
								{user.email.slice(0, 1).toUpperCase()}
							</span>
							<p className="app-sidebar__caption session-box__email">
								{user.email}
							</p>
							<button
								type="button"
								className="icon-button"
								onClick={() => void logout()}
								aria-label="Sign out"
								title="Sign out"
							>
								<Icon name="logout" size={18} />
								<span className="visually-hidden">Sign out</span>
							</button>
						</div>
					) : null}
					<div className="app-sidebar__row">
						<button
							type="button"
							className="theme-toggle"
							onClick={cycle}
							data-testid="theme-toggle"
						>
							<Icon name="sun" size={16} />
							{label}
						</button>
						{live ? null : (
							<div className="env-row">
								<SimulatedLabel />
								<InfoPopover label="Simulated environment">
									Bank, e-wallet and FX providers are simulated. Settlement uses
									the mock adapter or Stellar testnet. No real money moves.
								</InfoPopover>
							</div>
						)}
					</div>
				</div>
			</aside>

			<div className="app-body">
				<header className="app-topbar">
					<Link to="/dashboard" className="app-brand app-brand--compact">
						<span className="app-brand__mark" aria-hidden="true">
							<Icon name="bolt" size={16} />
						</span>
						<span className="app-brand__name-text">FlexiPay</span>
					</Link>
					<Link
						to="/account"
						className="app-topbar__account"
						aria-label="Account"
					>
						{user ? user.email.slice(0, 1).toUpperCase() : <Icon name="user" />}
					</Link>
				</header>
				<p
					className={
						live
							? "mode-banner mode-banner--live"
							: "mode-banner mode-banner--test"
					}
					data-testid="mode-banner"
					data-mode={live ? "live" : "test"}
				>
					<span className="mode-banner__dot" aria-hidden="true" />
					{live
						? "Live money. Payments use real USDC on Solana mainnet."
						: "Test mode. No real money moves."}
				</p>
				<main className="app-main">
					<Outlet />
				</main>
				<footer className="app-footer">
					<span>
						<b>FlexiPay</b> is part of FlexiWork
					</span>
					<span className="app-footer__family">
						FlexiWork · Starter · Stars · Regulars
					</span>
				</footer>
			</div>

			<nav className="tabbar" aria-label="Quick">
				{TABS.map((item) => (
					<NavLink
						key={item.to}
						to={item.to}
						end={item.end}
						className={
							item.to === "/"
								? "tabbar__item tabbar__item--send"
								: "tabbar__item"
						}
					>
						<span className="tabbar__icon">
							<Icon name={item.icon} size={item.to === "/" ? 24 : 22} />
						</span>
						<span className="tabbar__label">{item.label}</span>
					</NavLink>
				))}
				<button
					type="button"
					className={moreOpen ? "tabbar__item active" : "tabbar__item"}
					aria-expanded={moreOpen}
					aria-controls="tabbar-more"
					onClick={() => setMoreOpen((open) => !open)}
				>
					<span className="tabbar__icon">
						<Icon name="more" size={22} />
					</span>
					<span className="tabbar__label">More</span>
				</button>
			</nav>
			{moreOpen ? (
				<div className="sheet" id="tabbar-more" role="dialog" aria-label="More">
					<button
						type="button"
						className="sheet__scrim"
						aria-label="Close"
						onClick={() => setMoreOpen(false)}
					/>
					<div className="sheet__panel">
						<span className="sheet__grip" aria-hidden="true" />
						<Link to="/take-payment" className="sheet__link">
							<Icon name="request" />
							Get paid
						</Link>
						{MORE.map((item) => (
							<Link key={item.to} to={item.to} className="sheet__link">
								<Icon name={item.icon} />
								{item.label}
							</Link>
						))}
						<button type="button" className="sheet__link" onClick={cycle}>
							<Icon name="sun" />
							{label}
						</button>
						{user ? (
							<button
								type="button"
								className="sheet__link"
								onClick={() => void logout()}
							>
								<Icon name="logout" />
								Sign out
							</button>
						) : null}
					</div>
				</div>
			) : null}
		</div>
	)
}
