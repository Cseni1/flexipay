import { useCrossmintAuth, useWallet } from "@crossmint/client-sdk-react-ui"
import { useCallback, useEffect, useState } from "react"
import { QrCode } from "../components/QrCode"
import { Button, Notice, StaticField } from "../components/ui"
import { shortAddress } from "../solana/walletStandard"
import { formatUsdcBalance } from "./formatUsdcBalance"

type Props = {
	/** Notify parent when the FlexiPay Solana address is ready (for Add funds). */
	onAddressChange?: (address: string | null) => void
}

/**
 * Inner session UI: email login via Crossmint, then address, balances, receive QR.
 * Must render under FlexiPayWalletProviders.
 */
export function FlexiPayWalletSession({ onAddressChange }: Props = {}) {
	const { login, logout, status: authStatus, user } = useCrossmintAuth()
	const { wallet, status: walletStatus } = useWallet()
	const [usdcLabel, setUsdcLabel] = useState<string>("—")
	const [solLabel, setSolLabel] = useState<string>("—")
	const [tokenLines, setTokenLines] = useState<string[]>([])
	const [balanceError, setBalanceError] = useState<string | null>(null)
	const [balanceBusy, setBalanceBusy] = useState(false)
	const [copyState, setCopyState] = useState<"idle" | "copied" | "blocked">(
		"idle",
	)

	const refreshBalances = useCallback(async () => {
		if (!wallet) {
			setUsdcLabel("—")
			setSolLabel("—")
			setTokenLines([])
			setBalanceError(null)
			return
		}
		setBalanceBusy(true)
		setBalanceError(null)
		try {
			const balances = await wallet.balances()
			setUsdcLabel(formatUsdcBalance(balances.usdc))
			const solAmount = balances.nativeToken?.amount?.trim()
			setSolLabel(solAmount && solAmount.length > 0 ? solAmount : "—")
			const extras = Array.isArray(balances.tokens) ? balances.tokens : []
			setTokenLines(
				extras
					.map((row) => {
						if (!row || typeof row !== "object") return null
						const rec = row as {
							symbol?: string
							amount?: string
							mint?: string
						}
						const symbol =
							typeof rec.symbol === "string" && rec.symbol
								? rec.symbol
								: typeof rec.mint === "string"
									? shortAddress(rec.mint)
									: "token"
						const amount =
							typeof rec.amount === "string" && rec.amount ? rec.amount : "—"
						return `${symbol}: ${amount}`
					})
					.filter((line): line is string => Boolean(line)),
			)
		} catch {
			setUsdcLabel("—")
			setSolLabel("—")
			setTokenLines([])
			setBalanceError("Could not load balances from Crossmint.")
		} finally {
			setBalanceBusy(false)
		}
	}, [wallet])

	useEffect(() => {
		void refreshBalances()
	}, [refreshBalances])

	const address = wallet?.address?.trim() ?? ""
	const loggedIn = authStatus === "logged-in"
	const walletLoading =
		walletStatus === "in-progress" || authStatus === "in-progress"

	useEffect(() => {
		onAddressChange?.(loggedIn && address ? address : null)
		return () => onAddressChange?.(null)
	}, [loggedIn, address, onAddressChange])

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
					required. Devnet / test funds only — you can pay FlexiPay settlements
					from this wallet when signed in.
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
				<>
					<div className="form-grid" data-testid="flexipay-wallet-ready">
						<StaticField
							label="Address"
							value={
								<code
									className="code-text"
									data-testid="flexipay-wallet-address"
								>
									{shortAddress(address)}
								</code>
							}
						/>
						<StaticField
							label="SOL (devnet)"
							value={<span data-testid="flexipay-wallet-sol">{solLabel}</span>}
						/>
						<StaticField
							label="Devnet USDC"
							value={
								<span data-testid="flexipay-wallet-usdc">{usdcLabel}</span>
							}
						/>
						{tokenLines.length > 0 ? (
							<div className="field" data-testid="flexipay-wallet-tokens">
								<span className="field__label">Other tokens</span>
								<ul className="flexipay-wallet-tokens field__static">
									{tokenLines.map((line) => (
										<li key={line}>{line}</li>
									))}
								</ul>
							</div>
						) : null}
						<div className="form-actions">
							<Button
								type="button"
								variant="secondary"
								onClick={() => void refreshBalances()}
								disabled={balanceBusy}
								data-testid="flexipay-wallet-refresh"
							>
								{balanceBusy ? "Refreshing…" : "Refresh balance"}
							</Button>
							<Button
								type="button"
								variant="secondary"
								onClick={() => void logout()}
								data-testid="flexipay-wallet-logout"
							>
								Sign out
							</Button>
						</div>
					</div>

					<div className="receive-panel" data-testid="flexipay-wallet-receive">
						<p className="field__label">Receive</p>
						<p className="form-note">
							Share this Solana address for test funds. Devnet only.
						</p>
						<QrCode
							value={address}
							label={`QR for ${shortAddress(address)}`}
							size={180}
						/>
						<p className="mono receive-panel__address">{address}</p>
						<div className="form-actions">
							<Button
								type="button"
								variant="secondary"
								onClick={() => void copyAddress()}
								data-testid="flexipay-wallet-copy"
							>
								Copy address
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
				</>
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
