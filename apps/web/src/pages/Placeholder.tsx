import React from "react"

// Holds the place of the dashboard until CF0 builds the web shell and design system.
const Placeholder: React.FC = () => (
	<main style={{ maxWidth: "40rem", margin: "4rem auto", padding: "0 1rem" }}>
		<h1>FlexiPay</h1>
		<p>
			Payments across bank accounts, e-wallets and crypto wallets. Testnet
			build.
		</p>
		<p>
			<strong>Simulated:</strong> bank, e-wallet and FX providers. No real money
			moves.
		</p>
	</main>
)

export default Placeholder
