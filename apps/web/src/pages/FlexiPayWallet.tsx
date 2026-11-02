import { useState } from "react"
import { Link } from "react-router-dom"
import { QrCode } from "../components/QrCode"
import { SolanaWalletPanel } from "../components/solana/SolanaWalletPanel"
import {
	Button,
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

export default function FlexiPayWallet() {
	const [connected, setConnected] = useState<ConnectedSolanaWallet | null>(null)
	const [copied, setCopied] = useState(false)

	const copyAddress = async () => {
		if (!connected) return
		try {
			await navigator.clipboard.writeText(connected.address)
			setCopied(true)
		} catch {
			setCopied(false)
		}
	}

	return (
		<Page>
			<PageHeader
				eyebrow="Wallet"
				title="Connected wallet"
				description="Your connected Phantom or Solflare wallet on devnet — receive address, QR and on-chain balances. This is not a FlexiPay-held balance. An embedded FlexiPay wallet is coming soon."
				actions={
					<Link className="button button--primary" to="/">
						Pay someone
					</Link>
				}
			/>

			<Notice data-testid="wallet-devnet-note">
				Devnet only. Balances and addresses come from the connected Wallet
				Standard account and the public Solana RPC. FlexiPay never stores
				private keys or seed phrases.
			</Notice>

			<div className="wallet-hero" data-testid="wallet-hero">
				<div>
					<p className="eyebrow">Connected Solana wallet</p>
					<p className="wallet-hero__title">
						{connected
							? shortAddress(connected.address)
							: "No wallet connected"}
					</p>
					<p className="muted">
						USDC and SOL balances appear in the panel below after connect — read
						from chain, not invented.
					</p>
				</div>
				<div className="wallet-hero__aside">
					<div className="wallet-stat">
						<span className="wallet-stat__label">Network</span>
						<span className="wallet-stat__value">Solana · devnet</span>
					</div>
					<div className="wallet-stat">
						<span className="wallet-stat__label">Embedded wallet</span>
						<span className="wallet-stat__value">
							<SimulatedLabel>Coming soon</SimulatedLabel>
						</span>
					</div>
				</div>
			</div>

			<Grid>
				<SolanaWalletPanel
					title="Wallet Standard (devnet)"
					onConnected={setConnected}
				/>

				<Panel
					title="Receive"
					description="Share this Solana address to receive USDC on devnet. Only send USDC on Solana to it."
				>
					{connected ? (
						<div className="receive-panel" data-testid="wallet-receive">
							<QrCode
								value={`solana:${connected.address}`}
								label={`QR for ${shortAddress(connected.address)}`}
							/>
							<p className="field__label">Wallet address</p>
							<p className="mono receive-panel__address">{connected.address}</p>
							<div className="form-actions">
								<Button
									type="button"
									variant="secondary"
									onClick={() => void copyAddress()}
								>
									Copy address
								</Button>
								<span className="form-note" role="status">
									{copied ? "Copied" : ""}
								</span>
							</div>
						</div>
					) : (
						<p className="form-note">
							Connect a Solana wallet to show its receive address and QR.
						</p>
					)}
				</Panel>
			</Grid>

			<Panel
				title="Embedded FlexiPay wallet"
				description="Email or passkey wallet from a non-custodial partner — not wired until production access is confirmed."
				actions={<SimulatedLabel>Coming soon</SimulatedLabel>}
			>
				<p className="muted" data-testid="embedded-wallet-soon">
					Coming soon. Until an embedded-wallet partner (for example Crossmint)
					is approved, use a Wallet Standard Solana wallet on devnet. No seed
					phrase is ever stored by FlexiPay.
				</p>
			</Panel>
		</Page>
	)
}
