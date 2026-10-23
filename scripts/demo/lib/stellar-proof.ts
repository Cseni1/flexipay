import { AssertionFailure, fail } from "./assertions.ts"
import { BlockedError } from "./report.ts"

// A 64-hex string only looks like a Stellar hash. DF3 proves a real testnet settlement by asking
// the RPC for the transaction and checking the network passphrase and the operation result.

export interface StellarProof {
	hash: string
	status: string
	ledger: number
	/** Passphrase reported by the RPC, compared with the configured testnet passphrase. */
	passphrase: string
}

interface JsonRpcError {
	message?: string
}

const call = async (
	url: string,
	method: string,
	params: Record<string, unknown>,
	timeoutMs: number,
): Promise<unknown> => {
	let response: Response
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
			signal: AbortSignal.timeout(timeoutMs),
		})
	} catch (error) {
		throw new BlockedError([
			{
				what: `Stellar RPC ${method} is unreachable`,
				owner: "caller / Csaba (integration)",
				detail: error instanceof Error ? error.message : String(error),
			},
		])
	}
	let body: { result?: unknown; error?: JsonRpcError }
	try {
		body = (await response.json()) as typeof body
	} catch {
		throw new AssertionFailure(`Stellar RPC ${method} returned a non-JSON body`)
	}
	if (body.error) {
		throw new AssertionFailure(
			`Stellar RPC ${method}: ${body.error.message ?? "request failed"}`,
		)
	}
	if (!response.ok)
		throw new AssertionFailure(
			`Stellar RPC ${method} returned HTTP ${response.status}`,
		)
	return body.result
}

export function parseNetworkPassphrase(result: unknown): string {
	if (typeof result !== "object" || result === null)
		fail("RPC getNetwork returned no result")
	const passphrase = (result as { passphrase?: unknown }).passphrase
	if (typeof passphrase !== "string" || passphrase.length === 0) {
		fail("RPC getNetwork returned no passphrase")
	}
	return passphrase
}

export function parseTransactionResult(result: unknown): {
	status: string
	ledger: number
} {
	if (typeof result !== "object" || result === null)
		fail("RPC getTransaction returned no result")
	const { status, ledger } = result as { status?: unknown; ledger?: unknown }
	if (typeof status !== "string") fail("RPC getTransaction returned no status")
	if (typeof ledger !== "number") fail("RPC getTransaction returned no ledger")
	return { status, ledger }
}

/** Verifies that `hash` is a successful transaction on the configured testnet. */
export async function verifyStellarTransaction(options: {
	hash: string
	rpcUrl: string
	networkPassphrase: string
	timeoutMs: number
}): Promise<StellarProof> {
	const passphrase = parseNetworkPassphrase(
		await call(options.rpcUrl, "getNetwork", {}, options.timeoutMs),
	)
	if (passphrase !== options.networkPassphrase) {
		fail(
			`RPC reports network "${passphrase}", expected the configured testnet passphrase`,
		)
	}

	const result = await call(
		options.rpcUrl,
		"getTransaction",
		{ hash: options.hash },
		options.timeoutMs,
	)
	const { status, ledger } = parseTransactionResult(result)
	if (status !== "SUCCESS") {
		fail(`testnet transaction ${options.hash} is ${status}, not SUCCESS`)
	}
	return { hash: options.hash, status, ledger, passphrase }
}
