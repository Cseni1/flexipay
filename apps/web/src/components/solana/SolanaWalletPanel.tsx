import { getSolAndUsdcBalances } from "@flexipay/adapter-solana"
import { useCallback, useEffect, useState } from "react"
import { getSolanaConfig, type SolanaConfig } from "../../api/solanaClient"
import {
	connectSolanaWallet,
	disconnectSolanaWallet,
	listSolanaWallets,
	shortAddress,
	type ConnectedSolanaWallet,
	Connection,
} from "../../solana/walletStandard"
import { Button, Notice, Panel, StaticField } from "../ui"

type Props = {
	onConnected?: (connected: ConnectedSolanaWallet | null) => void
	title?: string
}

const lamportsToSol = (lamports: bigint): string => {
	const whole = lamports / 1_000_000_000n
	const frac = (lamports % 1_000_000_000n)
		.toString()
		.padStart(9, "0")
		.replace(/0+$/, "")
	return frac ? `${whole}.${frac}` : whole.toString()
}

const minorToUsdc = (minor: bigint, decimals: number): string => {
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
}: Props) {
	const [config, setConfig] = useState<SolanaConfig | null>(null)
	const [connected, setConnected] = useState<ConnectedSolanaWallet | null>(null)
	const [sol, setSol] = useState<string>("—")
	const [usdc, setUsdc] = useState<string>("—")
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

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
				setUsdc("—")
				return
			}
			const connection = new Connection(rpc, "confirmed")
			const bal = await getSolAndUsdcBalances(
				connection,
				session.address,
				cfg.usdcMint,
			)
			setSol(lamportsToSol(bal.solLamports))
			setUsdc(minorToUsdc(bal.usdcMinor, cfg.usdcDecimals))
		},
		[],
	)

	const connect = async () => {
		setBusy(true)
		setError(null)
		try {
			const session = await connectSolanaWallet()
			setConnected(session)
			onConnected?.(session)
			if (config) await refreshBalances(session, config)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Connect failed")
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
			setUsdc("—")
		} finally {
			setBusy(false)
		}
	}

	const available = listSolanaWallets().map((w) => w.name)

	return (
		<div data-testid="solana-wallet-panel">
			<Panel title={title}>
				<Notice>
					{config?.label ?? "Solana"} — Wallet Standard only. FlexiPay never
					stores private keys or seed phrases. Devnet balances are test assets,
					not mainnet USDC.
				</Notice>
				{error ? (
					<Notice tone="warning" data-testid="solana-wallet-error">
						{error}
					</Notice>
				) : null}
				{connected ? (
					<>
						<StaticField
							label="Connected wallet"
							value={shortAddress(connected.address)}
						/>
						<p className="form-note" data-testid="solana-wallet-address">
							{connected.address}
						</p>
						<StaticField label="SOL balance" value={sol} />
						<StaticField label="USDC balance (configured mint)" value={usdc} />
						<p className="form-note" data-testid="solana-usdc-balance">
							{usdc}
						</p>
						<div className="form-actions">
							<Button
								type="button"
								variant="secondary"
								disabled={busy}
								onClick={() => void disconnect()}
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
						<p className="form-note">
							Detected wallets:{" "}
							{available.length ? available.join(", ") : "none yet"}
						</p>
						<Button
							type="button"
							disabled={busy}
							onClick={() => void connect()}
							data-testid="solana-wallet-connect"
						>
							{busy ? "Connecting…" : "Connect Solana wallet"}
						</Button>
					</>
				)}
			</Panel>
		</div>
	)
}
