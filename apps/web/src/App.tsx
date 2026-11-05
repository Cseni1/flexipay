import { Navigate, Route, Routes } from "react-router-dom"
import { AppShell } from "./components/AppShell"
import Account from "./pages/Account"
import {
	ForgotPasswordPage,
	LoginPage,
	RegisterPage,
	ResetPasswordPage,
} from "./pages/AuthPages"
import ClaimPage from "./pages/ClaimPage"
import Dashboard from "./pages/Dashboard"
import Developers from "./pages/Developers"
import FlexiPayWallet from "./pages/FlexiPayWallet"
import PayFrom from "./pages/PayFrom"
import PaymentDetail from "./pages/PaymentDetail"
import PaymentsHistory from "./pages/PaymentsHistory"
import Recipients from "./pages/Recipients"
import SendPayment from "./pages/SendPayment"
import TakePayment from "./pages/TakePayment"
import { RequireSession } from "./providers/SessionProvider"

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
				<Route path="take-payment" element={<TakePayment />} />
				<Route path="dashboard" element={<Dashboard />} />
				<Route path="payments" element={<PaymentsHistory />} />
				<Route path="recipients" element={<Recipients />} />
				<Route path="pay-from" element={<PayFrom />} />
				<Route path="wallet" element={<FlexiPayWallet />} />
				<Route path="developers" element={<Developers />} />
				<Route path="account" element={<Account />} />
				<Route path="payments/:paymentId" element={<PaymentDetail />} />
			</Route>
			<Route path="claim/:claimToken" element={<ClaimPage />} />
			<Route path="*" element={<Navigate to="/" replace />} />
		</Routes>
	)
}

export default App
