/** Same shape as FlexiPayBalances in ./balances (not imported: the alias maps ./balances here). */
type FlexiPayBalances = {
	sol: string
	tokens: Array<{ asset: string; amount: string }>
}

/** Playwright-only balances for the stub wallet (FP_PRIVY_SDK_STUB=1); no RPC calls. */
export async function loadFlexiPayBalances(
	_address: string,
): Promise<FlexiPayBalances> {
	return {
		sol: "0.1",
		tokens: [
			{ asset: "USDC", amount: "12.5" },
			{ asset: "TGBP", amount: "25.00" },
		],
	}
}
