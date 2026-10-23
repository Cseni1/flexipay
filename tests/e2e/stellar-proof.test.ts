import { afterEach, describe, expect, it, vi } from "vitest"
import { AssertionFailure } from "../../scripts/demo/lib/assertions.ts"
import { BlockedError } from "../../scripts/demo/lib/report.ts"
import {
	parseNetworkPassphrase,
	parseTransactionResult,
	verifyStellarTransaction,
} from "../../scripts/demo/lib/stellar-proof.ts"

// The verifier is what turns a 64-hex string into settlement evidence. These tests use a fake
// RPC; they never touch testnet.

const TESTNET = "Test SDF Network ; September 2015"
const HASH = "b".repeat(64)

const response = (result: unknown): Response =>
	new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
		status: 200,
		headers: { "content-type": "application/json" },
	})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("Stellar RPC result parsing", () => {
	it("reads the passphrase and transaction result", () => {
		expect(parseNetworkPassphrase({ passphrase: TESTNET })).toBe(TESTNET)
		expect(parseTransactionResult({ status: "SUCCESS", ledger: 42 })).toEqual({
			status: "SUCCESS",
			ledger: 42,
		})
	})

	it("rejects a missing passphrase, status or ledger", () => {
		expect(() => parseNetworkPassphrase({})).toThrow(/no passphrase/)
		expect(() => parseTransactionResult({ ledger: 1 })).toThrow(/no status/)
		expect(() => parseTransactionResult({ status: "SUCCESS" })).toThrow(
			/no ledger/,
		)
	})
})

describe("verifyStellarTransaction", () => {
	it("proves a successful testnet transaction", async () => {
		const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
			const { method } = JSON.parse(String(init.body)) as { method: string }
			return response(
				method === "getNetwork"
					? { passphrase: TESTNET }
					: { status: "SUCCESS", ledger: 12345 },
			)
		})
		vi.stubGlobal("fetch", fetchMock)

		const proof = await verifyStellarTransaction({
			hash: HASH,
			rpcUrl: "https://rpc.example",
			networkPassphrase: TESTNET,
			timeoutMs: 1_000,
		})
		expect(proof).toEqual({
			hash: HASH,
			status: "SUCCESS",
			ledger: 12345,
			passphrase: TESTNET,
		})
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it("rejects a transaction from another network", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				response({
					passphrase: "Public Global Stellar Network ; September 2015",
				}),
			),
		)

		await expect(
			verifyStellarTransaction({
				hash: HASH,
				rpcUrl: "https://rpc.example",
				networkPassphrase: TESTNET,
				timeoutMs: 1_000,
			}),
		).rejects.toThrow(/expected the configured testnet/)
	})

	it("rejects a hash the chain does not know or did not succeed", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				const { method } = JSON.parse(String(init.body)) as { method: string }
				return response(
					method === "getNetwork"
						? { passphrase: TESTNET }
						: { status: "NOT_FOUND", ledger: 0 },
				)
			}),
		)

		await expect(
			verifyStellarTransaction({
				hash: HASH,
				rpcUrl: "https://rpc.example",
				networkPassphrase: TESTNET,
				timeoutMs: 1_000,
			}),
		).rejects.toBeInstanceOf(AssertionFailure)
	})

	it("blocks when the RPC cannot be reached", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed")
			}),
		)

		await expect(
			verifyStellarTransaction({
				hash: HASH,
				rpcUrl: "https://rpc.example",
				networkPassphrase: TESTNET,
				timeoutMs: 1_000,
			}),
		).rejects.toBeInstanceOf(BlockedError)
	})
})
