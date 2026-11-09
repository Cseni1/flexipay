// CCR-52: parse GET /v1/stats/solana defensively (public, aggregate numbers only).

export type SolanaProof = {
	cluster: "devnet" | "testnet" | "mainnet-beta"
	since: string | null
	settledPayments: number
	deliveredPayments: number
	volume: { asset: string; amount: string }[]
	uniqueWallets: number
	repeatWallets: number
	generatedAt: string
}

const count = (v: unknown): number =>
	typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0

export function parseSolanaProof(payload: unknown): SolanaProof {
	const raw = (payload && typeof payload === "object" ? payload : {}) as Record<
		string,
		unknown
	>
	const cluster =
		raw.cluster === "mainnet-beta" || raw.cluster === "testnet"
			? raw.cluster
			: "devnet"
	const volume = Array.isArray(raw.volume)
		? raw.volume.flatMap((row) => {
				const r = (row ?? {}) as Record<string, unknown>
				return typeof r.asset === "string" &&
					typeof r.amount === "string" &&
					/^\d+(\.\d+)?$/.test(r.amount)
					? [{ asset: r.asset, amount: r.amount }]
					: []
			})
		: []
	return {
		cluster,
		since: typeof raw.since === "string" ? raw.since : null,
		settledPayments: count(raw.settledPayments),
		deliveredPayments: count(raw.deliveredPayments),
		volume,
		uniqueWallets: count(raw.uniqueWallets),
		repeatWallets: count(raw.repeatWallets),
		generatedAt:
			typeof raw.generatedAt === "string"
				? raw.generatedAt
				: new Date(0).toISOString(),
	}
}
