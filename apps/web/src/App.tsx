import { Route, Routes } from "react-router-dom"
import Placeholder from "./pages/Placeholder"

function App() {
	return (
		<Routes>
			<Route path="*" element={<Placeholder />} />
		</Routes>
	)
}

export default App
