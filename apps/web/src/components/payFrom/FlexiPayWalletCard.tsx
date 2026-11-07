import { lazy, Suspense } from "react"
import {
	isFlexiPayWalletConfigured,
	readPrivyAppId,
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
		const appId = readPrivyAppId(import.meta.env)
		if (!appId) return null
		return (
			<FlexiPayWalletProviders appId={appId}>
				<FlexiPayWalletSession onAddressChange={onAddressChange} />
			</FlexiPayWalletProviders>
		)
	}
	return { default: Loaded }
})

/**
 * FlexiPay embedded Solana wallet (Privy) on Pay-from.
 * Lazy-loaded so the Privy auth/wallet graph stays out of the main bundle.
 */
export function FlexiPayWalletCard({ onAddressChange }: Props = {}) {
	const configured = isFlexiPayWalletConfigured(import.meta.env)

	return (
		<div data-testid="flexipay-wallet-card">
			<Panel
				title="FlexiPay wallet"
				description="Embedded Solana wallet with email or passkey sign-in (Privy) — for people without Phantom or Solflare. FlexiPay never holds your keys."
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
