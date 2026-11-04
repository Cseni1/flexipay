import "./buffer-shim"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import "@flexipay/web-lib/styles.css"
import "./styles/app.css"
import App from "./App.tsx"
import { SessionProvider } from "./providers/SessionProvider"

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<BrowserRouter>
			<SessionProvider>
				<App />
			</SessionProvider>
		</BrowserRouter>
	</StrictMode>,
)
