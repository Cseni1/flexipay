/**
 * Collapsible tip for receivers who chose Solana USDC but have no wallet yet.
 * No analytics / tracking — plain links only.
 */
export function NoWalletYetHelp() {
	return (
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
					, switch the wallet to Devnet, copy the address, then paste it above.
				</p>
			</div>
		</details>
	)
}
