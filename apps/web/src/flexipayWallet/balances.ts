import { getSolAndUsdcBalances } from "@flexipay/adapter-solana/browser"
import { Connection } from "@solana/web3.js"
import { getSolanaConfig } from "../api/solanaClient"
import { formatAssetAmount } from "../solana/assets"

export type FlexiPayBalances = {
	sol: string
	/** One line per configured settlement asset (USDC, TGBP), formatted. */
	tokens: Array<{ asset: string; amount: string }>
}

const lamportsToSol = (lamports: bigint): string => {
	const whole = lamports / 1_000_000_000n
	const frac = (lamports % 1_000_000_000n)
		.toString()
		.padStart(9, "0")
		.replace(/0+$/, "")
	return frac ? `${whole}.${frac}` : whole.toString()
}

/** Reads SOL and the configured token balances straight from Solana (no wallet SDK involved). */
export async function loadFlexiPayBalances(
	address: string,
): Promise<FlexiPayBalances> {
	const cfg = await getSolanaConfig()
	if (!cfg.publicRpcUrl) throw new Error("No public Solana RPC is configured")
	const connection = new Connection(cfg.publicRpcUrl, "confirmed")
	let sol = "—"
	const tokens: FlexiPayBalances["tokens"] = []
	for (const asset of cfg.assets) {
		const bal = await getSolAndUsdcBalances(connection, address, asset.mint)
		sol = lamportsToSol(bal.solLamports)
		tokens.push({
			asset: asset.asset,
			amount: formatAssetAmount(
				asset.asset,
				bal.usdcMinor.toString(),
				asset.decimals,
			),
		})
	}
	return { sol, tokens }
}
