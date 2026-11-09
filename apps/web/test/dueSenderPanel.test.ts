/**
 * CCR-51: the Due "Pay from your wallet" panel (first frame, facts in plain words) and the
 * Due funding API client.
 */
import assert from "node:assert/strict"
import { createElement, type ComponentType } from "react"
import { renderToString } from "react-dom/server"
import { afterEach, describe, test, vi } from "vitest"
import {
	ApiError,
	confirmDueFunding,
	getDueFunding,
	prepareDueFunding,
} from "../src/api/client.ts"

const load = <T>(path: string): Promise<T> =>
	import(/* @vite-ignore */ path) as Promise<T>

const { DueSenderPanel, dueFundingFacts, networkLabel } = await load<{
	DueSenderPanel: ComponentType<{ paymentId: string; onChanged: () => void }>
	dueFundingFacts: (f: unknown) => { label: string; value: string }[]
	networkLabel: (cluster: string) => string
}>("../src/components/solana/DueSenderPanel.tsx")

const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
const FUNDING_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"

const funding = {
	paymentId: "pay_due",
	paymentStatus: "processing",
	state: "awaiting_transfer",
	transferId: "tfr_1",
	cluster: "devnet",
	asset: "USDC",
	mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
	decimals: 6,
	amount: "99700001",
	recipient: FUNDING_ADDRESS,
	reference: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
	senderWallet: WALLET,
	expiresAt: "2026-11-09T14:00:00.000Z",
	signature: null,
	explorerTxUrlTemplate:
		"https://explorer.solana.com/tx/{signature}?cluster=devnet",
}

const stubFetch = (status: number, body: unknown) => {
	const calls: { url: string; init?: RequestInit }[] = []
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, init })
			return new Response(JSON.stringify(body), { status })
		}),
	)
	return calls
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("DueSenderPanel", () => {
	test("first frame renders the plain-words explanation without fetching", () => {
		const html = renderToString(
			createElement(DueSenderPanel, {
				paymentId: "pay_due",
				onChanged: () => {},
			}),
		)
		assert.ok(html.includes('data-testid="due-sender-panel"'))
		assert.ok(html.includes("straight to Due"))
		assert.ok(html.includes("FlexiPay never holds the money"))
		assert.ok(html.includes("Approve in your wallet"))
	})

	test("shows amount, network, wallets and deadline in plain words", () => {
		const facts = dueFundingFacts(funding)
		const byLabel = Object.fromEntries(facts.map((f) => [f.label, f.value]))
		assert.equal(byLabel.Amount, "99.700001 USDC")
		assert.equal(byLabel.Network, "Solana (devnet, test network)")
		assert.ok(byLabel["From your wallet"]?.startsWith(WALLET.slice(0, 4)))
		assert.ok(byLabel["To Due"]?.startsWith(FUNDING_ADDRESS.slice(0, 4)))
		assert.match(byLabel["Send before"] ?? "", /^\d\d:\d\d:\d\d$/)
		assert.equal(
			dueFundingFacts({ ...funding, expiresAt: null }).some(
				(f) => f.label === "Send before",
			),
			false,
		)
		assert.equal(networkLabel("mainnet-beta"), "Solana")
	})
})

describe("Due funding client", () => {
	test("reads and prepares funding instructions", async () => {
		let calls = stubFetch(200, funding)
		const read = await getDueFunding("pay_due")
		assert.equal(read.amount, "99700001")
		assert.equal(calls[0]!.url, "/v1/payments/pay_due/due/funding")
		calls = stubFetch(200, funding)
		await prepareDueFunding("pay_due", WALLET)
		assert.equal(calls[0]!.init?.method, "POST")
		assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
			walletAddress: WALLET,
		})
		assert.ok(
			new Headers(calls[0]!.init?.headers).get("Idempotency-Key")?.length,
		)
	})

	test("confirm returns pending until Solana confirms, then verified", async () => {
		stubFetch(202, {
			status: "pending",
			paymentId: "pay_due",
			signature: "5".repeat(88),
			message: "not yet",
		})
		assert.equal(
			(await confirmDueFunding("pay_due", "5".repeat(88))).status,
			"pending",
		)
		stubFetch(200, {
			paymentId: "pay_due",
			paymentStatus: "processing",
			transferId: "tfr_1",
			signature: "5".repeat(88),
			explorerUrl: "https://explorer.solana.com/tx/x",
		})
		const ok = await confirmDueFunding("pay_due", "5".repeat(88))
		assert.equal(ok.status, "verified")
	})

	test("a refused transfer surfaces Due's reason", async () => {
		stubFetch(422, {
			code: "wrong_sender",
			message: "This transfer came from a different wallet.",
		})
		await assert.rejects(
			confirmDueFunding("pay_due", "5".repeat(88)),
			(e: unknown) => e instanceof ApiError && e.code === "wrong_sender",
		)
	})
})
