/**
 * Collapsible tips for receivers who chose Solana USDC but have no wallet yet.
 * No analytics / tracking — plain links only.
 */
export function NoWalletYetHelp({ live = false }: { live?: boolean }) {
	return (
		<>
			<details className="claim-wallet-help" data-testid="claim-no-wallet-help">
				<summary>No wallet yet?</summary>
				<div className="claim-wallet-help__body">
					<p>
						Install{" "}
						<a
							href="https://phantom.com/download"
							target="_blank"
							rel="noreferrer"
						>
							Phantom
						</a>{" "}
						or{" "}
						<a href="https://solflare.com" target="_blank" rel="noreferrer">
							Solflare
						</a>
						{live
							? ", copy your Solana address, then paste it above."
							: ", switch the wallet to Devnet, copy the address, then paste it above."}
					</p>
				</div>
			</details>
			{live ? <KastHelp /> : null}
		</>
	)
}

/**
 * KAST accounts hold USDC on Solana, so a KAST deposit address works as a normal wallet
 * payout. Shown only with real money: test (devnet) USDC sent to a KAST address is lost.
 */
export function KastHelp() {
	return (
		<details className="claim-wallet-help" data-testid="claim-kast-help">
			<summary>Got a KAST account?</summary>
			<div className="claim-wallet-help__body">
				<p>
					You can get paid straight into{" "}
					<a href="https://www.kast.xyz" target="_blank" rel="noreferrer">
						KAST
					</a>
					. In the KAST app, find your USDC deposit address on the Solana
					network, copy it, then paste it above. Only use the Solana address:
					other networks won&apos;t work.
				</p>
			</div>
		</details>
	)
}
