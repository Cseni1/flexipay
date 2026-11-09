import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { formatUnits } from "../src/routes/stats.ts"
import { getSolanaRuntimeConfig } from "../src/solana/runtime-config.ts"
import { auth, startTestServer, type TestServer } from "./helpers.ts"

// CCR-52: public aggregate proof of payments settled on Solana.

describe("formatUnits", () => {
	it("renders base units as a trimmed decimal", () => {
		expect(formatUnits(1_250_500_000n, 6)).toBe("1250.5")
		expect(formatUnits(5_000_000n, 6)).toBe("5")
		expect(formatUnits(7n, 0)).toBe("7")
		expect(formatUnits(1n, 9)).toBe("0.000000001")
	})
})

describe("GET /v1/stats/solana", { timeout: 60_000 }, () => {
	let s: TestServer
	let quoteId = ""
	let recipientId = ""
	let orgId = ""

	beforeAll(async () => {
		s = await startTestServer()
		const org = await s.newOrg("Proof org")
		orgId = org.orgId
		const post = async (path: string, idem: string, body: unknown) =>
			(await (
				await fetch(`${s.base}${path}`, {
					method: "POST",
					headers: auth(org.key, { "idempotency-key": idem }),
					body: JSON.stringify(body),
				})
			).json()) as { id: string }
		recipientId = (
			await post("/v1/recipients", "r1", {
				name: "Worker A",
				kind: "individual",
				country: "US",
			})
		).id
		quoteId = (
			await post("/v1/quotes", "q1", {
				source: { type: "bank_account", currency: "USD", country: "US" },
				destination: {
					type: "bank_account",
					currency: "USD",
					country: "US",
					recipientKind: "individual",
				},
				amount: { side: "send", value: { amount: "10000", currency: "USD" } },
				policy: "cheapest",
			})
		).id
		expect(quoteId).toBeTruthy()
	})

	afterAll(async () => {
		await s?.stop()
	})

	let n = 0
	const add = (data: Record<string, unknown>) =>
		s.db.payment.create({
			data: {
				id: `pay_proof_${++n}`,
				organizationId: orgId,
				quoteId,
				recipientId,
				delivery: "direct",
				profile: "one_off",
				status: "paid",
				...data,
			},
		})

	it("counts verified on-chain payments, volume, unique and repeat wallets without personal data", async () => {
		const usdc = getSolanaRuntimeConfig().usdcMint
		await add({
			solanaPayer: "WalletA",
			solanaSettleMint: usdc,
			solanaSettleAmount: "10000000",
			solanaSettleDecimals: 6,
		})
		await add({
			solanaPayer: "WalletA",
			solanaSettleMint: usdc,
			solanaSettleAmount: "2500000",
			solanaSettleDecimals: 6,
			status: "processing",
		})
		await add({
			solanaPayer: "WalletB",
			solanaSettleMint: "UnknownMint111",
			solanaSettleAmount: "5",
			solanaSettleDecimals: 0,
		})
		await add({ blindpaySenderWallet: "WalletC", status: "processing" })
		// Not counted: sender-wallet payment never approved, and a plain payment.
		await add({ blindpaySenderWallet: "WalletD", status: "awaiting_funding" })
		await add({})

		const res = await fetch(`${s.base}/v1/stats/solana`)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toMatchObject({
			cluster: "devnet",
			since: null,
			settledPayments: 4,
			deliveredPayments: 2,
			uniqueWallets: 3,
			repeatWallets: 1,
		})
		expect(body.volume).toEqual([
			{ asset: "OTHER", amount: "5" },
			{ asset: "USDC", amount: "12.5" },
		])
		const text = JSON.stringify(body)
		for (const w of ["WalletA", "WalletB", "WalletC", "WalletD"]) {
			expect(text).not.toContain(w)
		}
		expect(text).not.toContain("pay_proof")
	})

	it("only counts payments after FP_PROOF_SINCE", async () => {
		process.env.FP_PROOF_SINCE = new Date(Date.now() + 60_000).toISOString()
		try {
			const body = await (await fetch(`${s.base}/v1/stats/solana`)).json()
			expect(body.settledPayments).toBe(0)
			expect(body.since).toBe(process.env.FP_PROOF_SINCE)
		} finally {
			delete process.env.FP_PROOF_SINCE
		}
		process.env.FP_PROOF_SINCE = "not a date"
		try {
			const body = await (await fetch(`${s.base}/v1/stats/solana`)).json()
			expect(body.since).toBeNull()
		} finally {
			delete process.env.FP_PROOF_SINCE
		}
	})
})
