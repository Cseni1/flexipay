import { getSolAndUsdcBalances } from "@flexipay/adapter-solana/browser"
import { useCallback, useEffect, useState } from "react"
import { getSolanaConfig, type SolanaConfig } from "../../api/solanaClient"
import {
	accountSupportsCluster,
	connectSolanaWallet,
	describeWalletUserError,
	disconnectSolanaWallet,
	listSolanaWallets,
	PREFERRED_USER_WALLETS,
	shortAddress,
	subscribeSolanaWallets,
	subscribeWalletAccountChanges,
	walletSupportsCluster,
	type ClusterLabel,
	type ConnectedSolanaWallet,
	Connection,
} from "../../solana/walletStandard"
import { Button, Notice, Panel, StaticField } from "../ui"

type Props = {
	onConnected?: (connected: ConnectedSolanaWallet | null) => void
	title?: string
	/**
	 * When true, include the Playwright harness wallet (automated proofs only).
	 * Human UI must leave this false so Phantom/Solflare are required.
	 */
	allowTestHarness?: boolean
}

const lamportsToSol = (lamports: bigint): string => {
	const whole = lamports / 1_000_000_000n
	const frac = (lamports % 1_000_000_000n)
		.toString()
		.padStart(9, "0")
		.replace(/0+$/, "")
	return frac ? `${whole}.${frac}` : whole.toString()
}

const minorToToken = (minor: bigint, decimals: number): string => {
	const scale = 10n ** BigInt(decimals)
	const whole = minor / scale
	const frac = (minor % scale)
		.toString()
		.padStart(decimals, "0")
		.replace(/0+$/, "")
	return frac ? `${whole}.${frac}` : whole.toString()
}

export function SolanaWalletPanel({
	onConnected,
	title = "Solana wallet",
	allowTestHarness = false,
}: Props) {
	const [config, setConfig] = useState<SolanaConfig | null>(null)
	const [connected, setConnected] = useState<ConnectedSolanaWallet | null>(null)
	const [walletNames, setWalletNames] = useState<string[]>([])
	const [sol, setSol] = useState<string>("—")
	const [tokenBalance, setTokenBalance] = useState<string>("—")
	const [networkWarning, setNetworkWarning] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	const refreshWalletList = useCallback(() => {
		setWalletNames(
			listSolanaWallets({ includeTestHarness: allowTestHarness }).map(
				(w) => w.name,
			),
		)
	}, [allowTestHarness])

	useEffect(() => {
		refreshWalletList()
		return subscribeSolanaWallets(refreshWalletList, {
			includeTestHarness: allowTestHarness,
		})
	}, [refreshWalletList, allowTestHarness])

	useEffect(() => {
		const controller = new AbortController()
		getSolanaConfig(controller.signal)
			.then(setConfig)
			.catch((cause) => {
				if (!controller.signal.aborted) {
					setError(
						cause instanceof Error
							? cause.message
							: "Solana config unavailable",
					)
				}
			})
		return () => controller.abort()
	}, [])

	const refreshBalances = useCallback(
		async (session: ConnectedSolanaWallet, cfg: SolanaConfig) => {
			const rpc = cfg.publicRpcUrl
			if (!rpc) {
				setSol("—")
				setTokenBalance("—")
				return
			}
			const connection = new Connection(rpc, "confirmed")
			const bal = await getSolAndUsdcBalances(
				connection,
				session.address,
				cfg.usdcMint,
			)
			setSol(lamportsToSol(bal.solLamports))
			setTokenBalance(minorToToken(bal.usdcMinor, cfg.usdcDecimals))
		},
		[],
	)

	const applyNetworkCheck = useCallback(
		(session: ConnectedSolanaWallet, cfg: SolanaConfig | null) => {
			if (!cfg) {
				setNetworkWarning(null)
				return
			}
			const cluster = cfg.cluster as ClusterLabel
			if (!walletSupportsCluster(session.wallet, cluster)) {
				setNetworkWarning(
					`${session.wallet.name} does not advertise ${cluster}. Open the extension, switch to Devnet, then reconnect.`,
				)
				return
			}
			if (!accountSupportsCluster(session.account, cluster)) {
				setNetworkWarning(
					`Connected account is not enabled for ${cluster}. Switch the wallet network to Devnet.`,
				)
				return
			}
			setNetworkWarning(null)
		},
		[],
	)

	useEffect(() => {
		if (!connected) return
		const wallet = connected.wallet
		const unsub = subscribeWalletAccountChanges(wallet, (accounts) => {
			const next = accounts[0]
			if (!next) {
				setConnected(null)
				onConnected?.(null)
				setSol("—")
				setTokenBalance("—")
				setNetworkWarning(null)
				return
			}
			const session: ConnectedSolanaWallet = {
				wallet,
				account: next,
				address: next.address,
			}
			setConnected(session)
			onConnected?.(session)
			applyNetworkCheck(session, config)
			if (config) void refreshBalances(session, config)
		})
		return unsub
		// Subscribe per wallet identity / address only — full `connected` would loop on session updates.
		// eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
	}, [
		connected?.wallet,
		connected?.address,
		config,
		onConnected,
		applyNetworkCheck,
		refreshBalances,
	])

	const connect = async (walletName?: string) => {
		setBusy(true)
		setError(null)
		try {
			const session = await connectSolanaWallet(walletName, {
				includeTestHarness: allowTestHarness,
			})
			setConnected(session)
			onConnected?.(session)
			applyNetworkCheck(session, config)
			if (config) await refreshBalances(session, config)
		} catch (cause) {
			setError(describeWalletUserError(cause))
		} finally {
			setBusy(false)
		}
	}

	const disconnect = async () => {
		if (!connected) return
		setBusy(true)
		try {
			await disconnectSolanaWallet(connected.wallet)
			setConnected(null)
			onConnected?.(null)
			setSol("—")
			setTokenBalance("—")
			setNetworkWarning(null)
			setError(null)
		} catch (cause) {
			setError(describeWalletUserError(cause))
		} finally {
			setBusy(false)
		}
	}

	const preferredDetected = PREFERRED_USER_WALLETS.filter((name) =>
		walletNames.includes(name),
	)
	const otherDetected = walletNames.filter(
		(name) => !(PREFERRED_USER_WALLETS as readonly string[]).includes(name),
	)

	return (
		<div data-testid="solana-wallet-panel">
			<Panel title={title}>
				<Notice>
					{config?.label ?? "Solana"} — Wallet Standard (Phantom / Solflare).
					FlexiPay never stores private keys or seed phrases. Balances below are
					for the configured Devnet test mint, not official mainnet USDC.
				</Notice>
				{error ? (
					<Notice tone="warning" data-testid="solana-wallet-error">
						{error}
					</Notice>
				) : null}
				{networkWarning ? (
					<Notice tone="warning" data-testid="solana-network-mismatch">
						{networkWarning}
					</Notice>
				) : null}
				{connected ? (
					<>
						<StaticField label="Wallet" value={connected.wallet.name} />
						<StaticField
							label="Connected address"
							value={shortAddress(connected.address)}
						/>
						<p className="form-note" data-testid="solana-wallet-address">
							{connected.address}
						</p>
						<StaticField label="SOL balance" value={sol} />
						<StaticField
							label="Devnet test-token balance (configured mint)"
							value={tokenBalance}
						/>
						<p className="form-note" data-testid="solana-usdc-balance">
							{tokenBalance}
						</p>
						<div className="form-actions">
							<Button
								type="button"
								variant="secondary"
								disabled={busy}
								onClick={() => void disconnect()}
								data-testid="solana-wallet-disconnect"
							>
								Disconnect
							</Button>
							<Button
								type="button"
								variant="secondary"
								disabled={busy || !config}
								onClick={() =>
									config && connected && void refreshBalances(connected, config)
								}
							>
								Refresh balances
							</Button>
						</div>
					</>
				) : (
					<>
						<p className="form-note" data-testid="solana-wallets-detected">
							Detected wallets:{" "}
							{walletNames.length ? walletNames.join(", ") : "none yet"}
						</p>
						{preferredDetected.length === 0 && otherDetected.length === 0 ? (
							<p className="form-note">
								Install Phantom or Solflare, unlock the extension, and set the
								network to <strong>Devnet</strong>.
							</p>
						) : null}
						<div className="form-actions">
							{preferredDetected.map((name, index) => (
								<Button
									key={name}
									type="button"
									disabled={busy}
									onClick={() => void connect(name)}
									data-testid={
										index === 0
											? "solana-wallet-connect"
											: `solana-wallet-connect-${name.toLowerCase()}`
									}
								>
									{busy ? "Connecting…" : `Connect ${name}`}
								</Button>
							))}
							{otherDetected.map((name, index) => (
								<Button
									key={name}
									type="button"
									variant="secondary"
									disabled={busy}
									onClick={() => void connect(name)}
									data-testid={
										preferredDetected.length === 0 && index === 0
											? "solana-wallet-connect"
											: `solana-wallet-connect-${name
													.toLowerCase()
													.replace(/\s+/g, "-")}`
									}
								>
									{busy ? "Connecting…" : `Connect ${name}`}
								</Button>
							))}
							{preferredDetected.length === 0 && otherDetected.length === 0 ? (
								<Button
									type="button"
									disabled={busy}
									onClick={() => void connect()}
									data-testid="solana-wallet-connect"
								>
									{busy ? "Connecting…" : "Connect Solana wallet"}
								</Button>
							) : null}
						</div>
					</>
				)}
			</Panel>
		</div>
	)
}
