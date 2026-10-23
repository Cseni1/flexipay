import { Navigate, Route, Routes } from "react-router-dom"
import { AppShell } from "./components/AppShell"
import ClaimPage from "./pages/ClaimPage"
import PaymentDetail from "./pages/PaymentDetail"
import SendPayment from "./pages/SendPayment"

function App() {
	return (
		<Routes>
			<Route element={<AppShell />}>
				<Route index element={<SendPayment />} />
				<Route path="payments/:paymentId" element={<PaymentDetail />} />
			</Route>
			<Route path="claim/:claimToken" element={<ClaimPage />} />
			<Route path="*" element={<Navigate to="/" replace />} />
		</Routes>
	)
}

export default App
