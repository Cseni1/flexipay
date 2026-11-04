import { useCrossmintAuth, useWallet } from "@crossmint/client-sdk-react-ui"
import { useEffect, useState } from "react"
import { Button, Notice, StaticField } from "../components/ui"
import { shortAddress } from "../solana/walletStandard"
import { formatUsdcBalance } from "./formatUsdcBalance"

/**
 * Inner session UI: email login via Crossmint, then show Solana address + USDC.
 * Must render under FlexiPayWalletProviders.
 */
export function FlexiPayWalletSession() {
	const { login, logout, status: authStatus, user } = useCrossmintAuth()
	const { wallet, status: walletStatus } = useWallet()
	const [usdcLabel, setUsdcLabel] = useState<string>("—")
	const [balanceError, setBalanceError] = useState<string | null>(null)
	const [copyState, setCopyState] = useState<"idle" | "copied" | "blocked">(
		"idle",
	)

	useEffect(() => {
		if (!wallet) {
			setUsdcLabel("—")
			setBalanceError(null)
			return
		}
		let active = true
		setBalanceError(null)
		void wallet
			.balances()
			.then((balances) => {
				if (!active) return
				setUsdcLabel(formatUsdcBalance(balances.usdc))
			})
			.catch(() => {
				if (!active) return
				setUsdcLabel("—")
				setBalanceError("Could not load USDC balance from Crossmint.")
			})
		return () => {
			active = false
		}
	}, [wallet])

	const address = wallet?.address?.trim() ?? ""
	const loggedIn = authStatus === "logged-in"
	const walletLoading =
		walletStatus === "in-progress" || authStatus === "in-progress"

	const copyAddress = async () => {
		if (!address) return
		try {
			await navigator.clipboard.writeText(address)
			setCopyState("copied")
		} catch {
			setCopyState("blocked")
		}
	}

	if (!loggedIn) {
		return (
			<div className="stack" data-testid="flexipay-wallet-logged-out">
				<p className="muted">
					Create a Solana wallet with your email (Crossmint staging). No Phantom
					required. Devnet / test funds only — we do not send payments from this
					wallet yet.
				</p>
				<div className="form-actions">
					<Button
						type="button"
						onClick={() => login()}
						disabled={walletLoading}
						data-testid="flexipay-wallet-open"
					>
						{walletLoading ? "Opening…" : "Create / open FlexiPay wallet"}
					</Button>
				</div>
			</div>
		)
	}

	return (
		<div className="stack" data-testid="flexipay-wallet-session">
			<p className="form-note">
				Signed in{user?.email ? ` as ${user.email}` : ""}. Test wallet — not for
				mainnet payments.
			</p>
			{walletLoading && !address ? (
				<p className="muted" role="status">
					Loading FlexiPay wallet…
				</p>
			) : null}
			{address ? (
				<div className="form-grid" data-testid="flexipay-wallet-ready">
					<StaticField
						label="Address"
						value={
							<code className="code-text" data-testid="flexipay-wallet-address">
								{shortAddress(address)}
							</code>
						}
					/>
					<StaticField
						label="Devnet USDC"
						value={<span data-testid="flexipay-wallet-usdc">{usdcLabel}</span>}
					/>
					<div className="form-actions">
						<Button
							type="button"
							variant="secondary"
							onClick={() => void copyAddress()}
							data-testid="flexipay-wallet-copy"
						>
							Copy address
						</Button>
						<Button
							type="button"
							variant="secondary"
							onClick={() => void logout()}
							data-testid="flexipay-wallet-logout"
						>
							Sign out
						</Button>
						<span role="status" aria-live="polite" className="form-note">
							{copyState === "copied"
								? "Copied"
								: copyState === "blocked"
									? "Copy blocked — select the address manually."
									: ""}
						</span>
					</div>
				</div>
			) : null}
			{balanceError ? (
				<Notice tone="warning" data-testid="flexipay-wallet-balance-error">
					{balanceError}
				</Notice>
			) : null}
			{walletStatus === "error" ? (
				<Notice tone="warning" data-testid="flexipay-wallet-error">
					Could not load the FlexiPay wallet. Check the Crossmint staging client
					key has Wallet API scopes, then try again.
				</Notice>
			) : null}
		</div>
	)
}
