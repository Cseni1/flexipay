import { Link, NavLink, Outlet } from "react-router-dom"
import { InfoPopover, SimulatedLabel } from "./ui"

export function AppShell() {
	return (
		<div className="app-shell">
			<aside className="app-sidebar">
				<Link to="/" className="app-brand">
					<h1 className="app-brand__name">FlexiPay</h1>
				</Link>
				<p className="app-brand__note">Testnet build</p>

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
					<NavLink to="/developers" className="nav-link">
						<span className="nav-link__dot" aria-hidden="true" />
						Developers
					</NavLink>
				</nav>

				<div className="app-sidebar__footer">
					<div className="env-row">
						<SimulatedLabel />
						<InfoPopover label="Simulated environment">
							Bank, e-wallet and FX providers are simulated. Settlement uses the
							mock adapter or Stellar testnet. No real money moves.
						</InfoPopover>
					</div>
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
