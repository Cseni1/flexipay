import { lazy, Suspense, useState } from "react"
import { Link } from "react-router-dom"
import { AddFundsPanel } from "../components/payFrom/AddFundsPanel"
import { SolanaWalletPanel } from "../components/solana/SolanaWalletPanel"
import {
	Grid,
	Notice,
	Page,
	PageHeader,
	Panel,
	SimulatedLabel,
} from "../components/ui"
import {
	shortAddress,
	type ConnectedSolanaWallet,
} from "../solana/walletStandard"

const FlexiPayWalletCard = lazy(async () => {
	const mod = await import("../components/payFrom/FlexiPayWalletCard")
	return { default: mod.FlexiPayWalletCard }
})

const COMING_SOON = [
	{
		id: "card",
		title: "Card",
		detail:
			"Card spending needs a card-issuing partner. Not available in this build.",
	},
	{
		id: "cash",
		title: "Cash out",
		detail:
			"Cash-out needs a cash or ramp partner. Not available in this build.",
	},
	{
		id: "bank",
		title: "Bank account",
		detail:
			"Bank funding and ACH open country by country once a licensed partner confirms the route. Not available in this build.",
	},
] as const

export default function PayFrom() {
	const [connected, setConnected] = useState<ConnectedSolanaWallet | null>(null)

	return (
		<Page>
			<PageHeader
				eyebrow="Funding"
				title="Pay from"
				description="Link the accounts you fund payments from. Solana wallets connect through Wallet Standard on devnet; card, cash-out and bank stay coming soon."
				actions={
					<Link className="button button--primary" to="/">
						New payment
					</Link>
				}
			/>

			<Notice data-testid="pay-from-devnet-note">
				Devnet only for Solana. Connected wallet balances are read from chain.
				Card, cash-out and bank are labelled coming soon — nothing is simulated
				as a live balance.
			</Notice>

			<Grid>
				<Panel
					title="Solana wallet"
					description="Connect a Wallet Standard Solana wallet (for example Phantom) and pay with devnet USDC when a payment is ready to settle."
					actions={
						connected ? (
							<span className="pill pill--ok">Connected</span>
						) : undefined
					}
				>
					{connected ? (
						<p className="form-note" data-testid="pay-from-connected">
							Funding from {shortAddress(connected.address)}. Full address and
							balances are in the wallet panel.
						</p>
					) : (
						<p className="form-note">
							No Solana wallet connected yet. Use the panel below.
						</p>
					)}
					<SolanaWalletPanel
						title="Connect Solana (devnet)"
						onConnected={setConnected}
						allowTestHarness={import.meta.env.DEV}
					/>
				</Panel>

				<Suspense
					fallback={
						<p className="form-note" role="status">
							Loading FlexiPay wallet…
						</p>
					}
				>
					<FlexiPayWalletCard />
				</Suspense>

				<AddFundsPanel walletAddress={connected ? connected.address : null} />

				<Panel
					title="Other funding methods"
					description="Honest shells until partner access is confirmed."
				>
					<ul className="coming-soon-list" data-testid="pay-from-coming-soon">
						{COMING_SOON.map((item) => (
							<li key={item.id} className="coming-soon-item">
								<div className="coming-soon-item__head">
									<strong>{item.title}</strong>
									<SimulatedLabel>Coming soon</SimulatedLabel>
								</div>
								<p className="muted">{item.detail}</p>
							</li>
						))}
					</ul>
				</Panel>
			</Grid>
		</Page>
	)
}
