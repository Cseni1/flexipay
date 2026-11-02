import { Link, NavLink, Outlet } from "react-router-dom"
import { useTheme } from "../hooks/useTheme"
import { useSession } from "../providers/SessionProvider"
import { ApiStatus } from "./ApiStatus"
import { InfoPopover, SimulatedLabel } from "./ui"

export function AppShell() {
	const { state, logout } = useSession()
	const { cycle, label } = useTheme()
	const user = state.status === "signed_in" ? state.session.user : null
	return (
		<div className="app-shell">
			<aside className="app-sidebar">
				<Link to="/" className="app-brand">
					<span className="app-brand__mark" aria-hidden="true" />
					<h1 className="app-brand__name">FlexiPay</h1>
				</Link>
				<ApiStatus />

				<nav className="app-nav" aria-label="Primary">
					<NavLink to="/dashboard" className="nav-link">
						<span className="nav-link__dot" aria-hidden="true" />
						Dashboard
					</NavLink>
					<NavLink to="/payments" end className="nav-link">
						<span className="nav-link__dot" aria-hidden="true" />
						Payments
					</NavLink>
					<NavLink to="/" end className="nav-link">
						<span className="nav-link__dot" aria-hidden="true" />
						New payment
					</NavLink>
					<NavLink to="/recipients" className="nav-link">
						<span className="nav-link__dot" aria-hidden="true" />
						Recipients
					</NavLink>
					<NavLink to="/pay-from" className="nav-link">
						<span className="nav-link__dot" aria-hidden="true" />
						Pay from
					</NavLink>
					<NavLink to="/wallet" className="nav-link">
						<span className="nav-link__dot" aria-hidden="true" />
						FlexiPay wallet
					</NavLink>
					<NavLink to="/developers" className="nav-link">
						<span className="nav-link__dot" aria-hidden="true" />
						Developers
					</NavLink>
				</nav>

				{state.status === "unconfigured" ? (
					<div className="app-sidebar__footer">
						<Link to="/login">Sign in</Link>
					</div>
				) : null}

				{user ? (
					<div className="app-sidebar__footer" data-testid="session-box">
						<p className="app-sidebar__caption">{user.email}</p>
						<button type="button" onClick={() => void logout()}>
							Sign out
						</button>
					</div>
				) : null}

				<div className="app-sidebar__footer">
					<div className="env-row">
						<SimulatedLabel />
						<InfoPopover label="Simulated environment">
							Bank, e-wallet and FX providers are simulated. Settlement uses the
							mock adapter or Stellar testnet. No real money moves.
						</InfoPopover>
					</div>
					<button
						type="button"
						className="theme-toggle"
						onClick={cycle}
						data-testid="theme-toggle"
					>
						{label}
					</button>
					<p className="app-sidebar__caption">
						Demo environment. Nothing here moves real funds.
					</p>
				</div>
			</aside>

			<div className="app-body">
				<main className="app-main">
					<Outlet />
				</main>
			</div>
		</div>
	)
}
