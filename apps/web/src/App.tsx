import { Navigate, Route, Routes } from "react-router-dom"
import { AppShell } from "./components/AppShell"
import { LiveMoneyProvider } from "./live/LiveMoney"
import Account from "./pages/Account"
import {
	ForgotPasswordPage,
	LoginPage,
	RegisterPage,
	ResetPasswordPage,
} from "./pages/AuthPages"
import BlindpayTermsDone from "./pages/BlindpayTermsDone"
import ClaimPage from "./pages/ClaimPage"
import Dashboard from "./pages/Dashboard"
import Developers from "./pages/Developers"
import FlexiPayWallet from "./pages/FlexiPayWallet"
import PayFrom from "./pages/PayFrom"
import PaymentDetail from "./pages/PaymentDetail"
import PaymentsHistory from "./pages/PaymentsHistory"
import ProofPage from "./pages/ProofPage"
import Recipients from "./pages/Recipients"
import SendPayment from "./pages/SendPayment"
import TakePayment from "./pages/TakePayment"
import WhereWePay from "./pages/WhereWePay"
import { RequireSession } from "./providers/SessionProvider"

function App() {
	return (
		<LiveMoneyProvider>
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
					<Route path="where-we-pay" element={<WhereWePay />} />
					<Route path="account" element={<Account />} />
					<Route path="payments/:paymentId" element={<PaymentDetail />} />
					<Route path="blindpay/terms-done" element={<BlindpayTermsDone />} />
				</Route>
				<Route path="claim/:claimToken" element={<ClaimPage />} />
				<Route path="proof" element={<ProofPage />} />
				<Route path="*" element={<Navigate to="/" replace />} />
			</Routes>
		</LiveMoneyProvider>
	)
}

export default App
