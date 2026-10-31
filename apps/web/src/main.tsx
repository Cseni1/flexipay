import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import "@flexipay/web-lib/styles.css"
import "./styles/app.css"
import App from "./App.tsx"
import { maybeRegisterDevnetTestWallet } from "./solana/devnetTestWallet.ts"

maybeRegisterDevnetTestWallet()

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<BrowserRouter>
			<App />
		</BrowserRouter>
	</StrictMode>,
)
