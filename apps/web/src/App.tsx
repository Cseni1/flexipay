import { lazy, Suspense } from "react"
import { Navigate, Route, Routes } from "react-router-dom"
import { AppShell } from "./components/AppShell"
import ClaimPage from "./pages/ClaimPage"
import Dashboard from "./pages/Dashboard"
import Developers from "./pages/Developers"
import PaymentDetail from "./pages/PaymentDetail"
import PaymentsHistory from "./pages/PaymentsHistory"
import SendPayment from "./pages/SendPayment"

// Fixture-only state gallery for the passkey claim. `import.meta.env.DEV` is statically false in
// a production build, so the route and its chunk are not part of the shipped app.
const PasskeyClaimStates = import.meta.env.DEV
	? lazy(() => import("./pages/PasskeyClaimStates"))
	: null

function App() {
	return (
		<Routes>
			<Route element={<AppShell />}>
				<Route index element={<SendPayment />} />
				<Route path="dashboard" element={<Dashboard />} />
				<Route path="payments" element={<PaymentsHistory />} />
				<Route path="developers" element={<Developers />} />
				<Route path="payments/:paymentId" element={<PaymentDetail />} />
			</Route>
			<Route path="claim/:claimToken" element={<ClaimPage />} />
			{PasskeyClaimStates ? (
				<Route
					path="_dev/passkey-states"
					element={
						<Suspense fallback={null}>
							<PasskeyClaimStates />
						</Suspense>
					}
				/>
			) : null}
			<Route path="*" element={<Navigate to="/" replace />} />
		</Routes>
	)
}

export default App
