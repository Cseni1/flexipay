// CCR-49: Jupiter swap client (Solana mainnet). FlexiPay never signs or holds the tokens: it asks
// Jupiter for a quote and an unsigned swap transaction that the sender's own wallet signs.

import { jsonRequest, type FetchLike } from "./http.ts"

/** Free Jupiter endpoint; with JUPITER_API_KEY the keyed endpoint is used instead. */
export const JUPITER_LITE_BASE = "https://lite-api.jup.ag/swap/v1"
export const JUPITER_KEYED_BASE = "https://api.jup.ag/swap/v1"

export interface JupiterOptions {
	fetch?: FetchLike
	apiKey?: string
	baseUrl?: string
	timeoutMs?: number
}

export interface JupiterExactOutQuote {
	inputMint: string
	outputMint: string
	/** Expected input, base units. */
	inAmount: string
	/** Exact output, base units. */
	outAmount: string
	/** Most input the swap may take after slippage, base units. */
	maxInAmount: string
	slippageBps: number
	/** Fraction, e.g. 0.001 = 0.1 %. */
	priceImpact: number
	/** Venue labels, for display. */
	route: string[]
	/** Jupiter's quote, passed back unchanged to build the swap. */
	raw: Record<string, unknown>
}

export class JupiterError extends Error {
	readonly code: "no_route" | "jupiter_unavailable" | "bad_response"
	constructor(code: JupiterError["code"], message: string) {
		super(message)
		this.name = "JupiterError"
		this.code = code
	}
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const DIGITS = /^\d+$/

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined
}

export class JupiterClient {
	private readonly fetchImpl: FetchLike
	private readonly base: string
	private readonly headers: Record<string, string>
	private readonly timeoutMs: number

	constructor(opts: JupiterOptions = {}) {
		this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike)
		const key = opts.apiKey?.trim()
		this.base = (opts.baseUrl ?? (key ? JUPITER_KEYED_BASE : JUPITER_LITE_BASE)).replace(/\/+$/, "")
		this.headers = key ? { "x-api-key": key } : {}
		this.timeoutMs = opts.timeoutMs ?? 15_000
	}

	/** Quote for an exact amount of `outputMint`, paid with `inputMint`. */
	async quoteExactOut(input: {
		inputMint: string
		outputMint: string
		amount: bigint
		slippageBps: number
	}): Promise<JupiterExactOutQuote> {
		if (!BASE58.test(input.inputMint) || !BASE58.test(input.outputMint)) {
			throw new JupiterError("bad_response", "invalid mint")
		}
		if (input.amount <= 0n) throw new JupiterError("bad_response", "amount must be positive")
		const qs = new URLSearchParams({
			inputMint: input.inputMint,
			outputMint: input.outputMint,
			amount: input.amount.toString(),
			swapMode: "ExactOut",
			slippageBps: String(input.slippageBps),
			restrictIntermediateTokens: "true",
		})
		const res = await this.call("GET", `${this.base}/quote?${qs.toString()}`)
		const body = (res.json ?? {}) as Record<string, unknown>
		if (res.status === 400 || res.status === 404) {
			throw new JupiterError(
				"no_route",
				str(body.error) ?? "Jupiter found no route for this swap",
			)
		}
		if (res.status !== 200) {
			throw new JupiterError("jupiter_unavailable", `Jupiter quote failed (${res.status})`)
		}
		const inAmount = str(body.inAmount)
		const outAmount = str(body.outAmount)
		const threshold = str(body.otherAmountThreshold)
		if (
			str(body.inputMint) !== input.inputMint ||
			str(body.outputMint) !== input.outputMint ||
			str(body.swapMode) !== "ExactOut" ||
			!inAmount ||
			!DIGITS.test(inAmount) ||
			!outAmount ||
			!DIGITS.test(outAmount) ||
			!threshold ||
			!DIGITS.test(threshold)
		) {
			throw new JupiterError("bad_response", "Jupiter returned an unexpected quote")
		}
		if (BigInt(outAmount) < input.amount) {
			throw new JupiterError("bad_response", "Jupiter quoted less than the amount asked for")
		}
		const impact = Number(str(body.priceImpactPct) ?? "0")
		const plan = Array.isArray(body.routePlan) ? body.routePlan : []
		const route = plan
			.map((step) => str((step as { swapInfo?: { label?: unknown } })?.swapInfo?.label))
			.filter((l): l is string => !!l)
		return {
			inputMint: input.inputMint,
			outputMint: input.outputMint,
			inAmount,
			outAmount,
			maxInAmount: threshold,
			slippageBps: input.slippageBps,
			priceImpact: Number.isFinite(impact) ? Math.abs(impact) : 1,
			route,
			raw: body,
		}
	}

	/** Unsigned versioned swap transaction (base64) for `userPublicKey` to sign. */
	async swapTransaction(input: {
		quote: JupiterExactOutQuote
		userPublicKey: string
	}): Promise<{ transaction: string; lastValidBlockHeight: number | null }> {
		if (!BASE58.test(input.userPublicKey)) {
			throw new JupiterError("bad_response", "invalid wallet address")
		}
		const res = await this.call("POST", `${this.base}/swap`, {
			quoteResponse: input.quote.raw,
			userPublicKey: input.userPublicKey,
			wrapAndUnwrapSol: true,
			dynamicComputeUnitLimit: true,
			prioritizationFeeLamports: {
				priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: "medium" },
			},
		})
		const body = (res.json ?? {}) as Record<string, unknown>
		if (res.status !== 200) {
			throw new JupiterError("jupiter_unavailable", `Jupiter swap failed (${res.status})`)
		}
		const transaction = str(body.swapTransaction)
		if (!transaction || !/^[A-Za-z0-9+/]+={0,2}$/.test(transaction)) {
			throw new JupiterError("bad_response", "Jupiter returned no swap transaction")
		}
		const height = body.lastValidBlockHeight
		return {
			transaction,
			lastValidBlockHeight: typeof height === "number" ? height : null,
		}
	}

	private async call(method: "GET" | "POST", url: string, body?: unknown) {
		try {
			return await jsonRequest(this.fetchImpl, {
				method,
				url,
				headers: this.headers,
				body,
				timeoutMs: this.timeoutMs,
			})
		} catch {
			throw new JupiterError("jupiter_unavailable", "Jupiter could not be reached")
		}
	}
}
