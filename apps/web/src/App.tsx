import { lazy, Suspense } from "react"
import { Navigate, Route, Routes } from "react-router-dom"
import { AppShell } from "./components/AppShell"
import {
	ForgotPasswordPage,
	LoginPage,
	RegisterPage,
	ResetPasswordPage,
} from "./pages/AuthPages"
import ClaimPage from "./pages/ClaimPage"
import Dashboard from "./pages/Dashboard"
import Developers from "./pages/Developers"
import PaymentDetail from "./pages/PaymentDetail"
import PaymentsHistory from "./pages/PaymentsHistory"
import Recipients from "./pages/Recipients"
import SendPayment from "./pages/SendPayment"
import { RequireSession } from "./providers/SessionProvider"

// Fixture-only state gallery for the passkey claim. `import.meta.env.DEV` is statically false in
// a production build, so the route and its chunk are not part of the shipped app.
const PasskeyClaimStates = import.meta.env.DEV
	? lazy(() => import("./pages/PasskeyClaimStates"))
	: null

function App() {
	return (
		<Routes>
			<Route path="login" element={<LoginPage />} />
			<Route path="register" element={<RegisterPage />} />
			<Route path="forgot-password" element={<ForgotPasswordPage />} />
			<Route path="reset-password" element={<ResetPasswordPage />} />
			<Route
				element={
					<RequireSession>
						<AppShell />
					</RequireSession>
				}
			>
				<Route index element={<SendPayment />} />
				<Route path="dashboard" element={<Dashboard />} />
				<Route path="payments" element={<PaymentsHistory />} />
				<Route path="recipients" element={<Recipients />} />
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
