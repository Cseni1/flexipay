import { z } from "zod"
import { defineRoute, type RouteDef } from "../routes.ts"
import { getSolanaRuntimeConfig } from "../solana/runtime-config.ts"

// CCR-52: public proof of on-chain activity. Aggregates only: counts, volumes, wallet
// counts. Never returns wallet addresses, names, amounts per payment or any identifier.

const AssetVolume = z
	.object({
		asset: z.string(),
		/** Decimal string in whole units (e.g. "1250.5"). */
		amount: z.string(),
	})
	.strict()

export const SolanaProofSchema = z
	.object({
		cluster: z.enum(["devnet", "testnet", "mainnet-beta"]),
		/** Start of the counted window (FP_PROOF_SINCE), or null for all time. */
		since: z.string().nullable(),
		/** Payments whose money moved on Solana and was verified on-chain. */
		settledPayments: z.number().int().nonnegative(),
		/** Of those, paid out to the recipient. */
		deliveredPayments: z.number().int().nonnegative(),
		volume: z.array(AssetVolume),
		uniqueWallets: z.number().int().nonnegative(),
		/** Wallets that paid more than once. */
		repeatWallets: z.number().int().nonnegative(),
		generatedAt: z.string(),
	})
	.strict()

export type SolanaProof = z.infer<typeof SolanaProofSchema>

/** Sum of integer base units, rendered as a decimal string without trailing zeros. */
export function formatUnits(total: bigint, decimals: number): string {
	if (decimals <= 0) return total.toString()
	const base = 10n ** BigInt(decimals)
	const whole = total / base
	const frac = (total % base)
		.toString()
		.padStart(decimals, "0")
		.replace(/0+$/, "")
	return frac ? `${whole}.${frac}` : whole.toString()
}

function sinceFromEnv(env: Record<string, string | undefined>): Date | null {
	const raw = env.FP_PROOF_SINCE?.trim()
	if (!raw) return null
	const at = new Date(raw)
	return Number.isNaN(at.getTime()) ? null : at
}

export const statsRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "get",
		path: "/v1/stats/solana",
		summary:
			"Public aggregate proof of payments settled on Solana (no personal data)",
		auth: "none",
		success: { status: 200, schema: SolanaProofSchema },
		handler: async (ctx) => {
			const cfg = getSolanaRuntimeConfig()
			const since = sinceFromEnv(process.env)
			const createdAt = since ? { gte: since } : undefined
			// Verified on-chain transfers (direct settle, till QR) and sender-wallet payouts.
			const rows = await ctx.db.payment.findMany({
				where: {
					...(createdAt ? { createdAt } : {}),
					OR: [
						{ solanaPayer: { not: null } },
						{
							blindpaySenderWallet: { not: null },
							status: { in: ["processing", "paid"] },
						},
					],
				},
				select: {
					status: true,
					solanaPayer: true,
					solanaSettleMint: true,
					solanaSettleAmount: true,
					solanaSettleDecimals: true,
					blindpaySenderWallet: true,
				},
			})

			const assetByMint = new Map(cfg.assets.map((a) => [a.mint, a.asset]))
			const totals = new Map<string, { total: bigint; decimals: number }>()
			const perWallet = new Map<string, number>()
			let delivered = 0
			for (const row of rows) {
				if (row.status === "paid") delivered += 1
				const wallet = row.solanaPayer ?? row.blindpaySenderWallet
				if (wallet) perWallet.set(wallet, (perWallet.get(wallet) ?? 0) + 1)
				if (
					row.solanaSettleMint &&
					row.solanaSettleAmount &&
					/^\d+$/.test(row.solanaSettleAmount) &&
					row.solanaSettleDecimals !== null
				) {
					const asset = assetByMint.get(row.solanaSettleMint) ?? "OTHER"
					const entry = totals.get(asset) ?? {
						total: 0n,
						decimals: row.solanaSettleDecimals,
					}
					entry.total += BigInt(row.solanaSettleAmount)
					totals.set(asset, entry)
				}
			}
			const now = (ctx.runtime?.now ?? (() => new Date()))()
			return {
				cluster: cfg.cluster,
				since: since ? since.toISOString() : null,
				settledPayments: rows.length,
				deliveredPayments: delivered,
				volume: [...totals.entries()]
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([asset, v]) => ({
						asset,
						amount: formatUnits(v.total, v.decimals),
					})),
				uniqueWallets: perWallet.size,
				repeatWallets: [...perWallet.values()].filter((n) => n > 1).length,
				generatedAt: now.toISOString(),
			}
		},
	}),
]
