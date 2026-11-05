import { lazy, Suspense } from "react"
import {
	isFlexiPayWalletConfigured,
	readCrossmintClientKey,
} from "../../flexipayWallet/config"
import { Panel } from "../ui"

type Props = {
	onAddressChange?: (address: string | null) => void
}

const FlexiPayWalletLazy = lazy(async () => {
	const [{ FlexiPayWalletProviders }, { FlexiPayWalletSession }] =
		await Promise.all([
			import("../../flexipayWallet/FlexiPayWalletProviders"),
			import("../../flexipayWallet/FlexiPayWalletSession"),
		])
	function Loaded({ onAddressChange }: Props) {
		const apiKey = readCrossmintClientKey(import.meta.env)
		if (!apiKey) return null
		return (
			<FlexiPayWalletProviders apiKey={apiKey}>
				<FlexiPayWalletSession onAddressChange={onAddressChange} />
			</FlexiPayWalletProviders>
		)
	}
	return { default: Loaded }
})

/**
 * Optional Crossmint embedded Solana wallet on Pay-from.
 * Lazy-loaded so the Crossmint auth/wallet graph stays out of the main bundle.
 */
export function FlexiPayWalletCard({ onAddressChange }: Props = {}) {
	const configured = isFlexiPayWalletConfigured(import.meta.env)

	return (
		<div data-testid="flexipay-wallet-card">
			<Panel
				title="FlexiPay wallet"
				description="Optional embedded Solana wallet via Crossmint email sign-in — for people without Phantom or Solflare."
				actions={
					<span
						className="pill pill--test"
						data-testid="flexipay-wallet-test-badge"
					>
						Test wallet - devnet - no real money
					</span>
				}
			>
				{configured ? (
					<Suspense
						fallback={
							<p className="form-note" role="status">
								Loading FlexiPay wallet…
							</p>
						}
					>
						<FlexiPayWalletLazy onAddressChange={onAddressChange} />
					</Suspense>
				) : (
					<p className="form-note" data-testid="flexipay-wallet-unconfigured">
						FlexiPay wallet isn&apos;t configured
					</p>
				)}
			</Panel>
		</div>
	)
}
