import bs58 from "bs58"

type SendParams = { serializedTransaction: string }

type SendResult = {
	hash: string
	explorerLink?: string
	transactionId?: string
}

/** Minimal wallet shape used for FlexiPay Solana pay (Crossmint or stub). */
export type FlexiPaySolanaWallet = {
	address: string
	sendTransaction?: (params: SendParams) => Promise<SendResult>
}

type SerializableLegacyTx = {
	serialize: (config?: {
		requireAllSignatures?: boolean
		verifySignatures?: boolean
	}) => Uint8Array | Buffer | number[]
}

/**
 * Send a legacy Transaction (from buildUsdcTransferTransaction) through the
 * Crossmint embedded Solana wallet as a base58-serialized payload.
 * Prefer duck-typed `wallet.sendTransaction` (stub / SolanaWallet instance).
 * Falls back to `SolanaWallet.from` for a plain Crossmint Wallet.
 */
export async function sendFlexiPaySolanaTransaction(
	wallet: FlexiPaySolanaWallet,
	legacyTransaction: SerializableLegacyTx,
): Promise<string> {
	const bytes = Uint8Array.from(
		legacyTransaction.serialize({
			requireAllSignatures: false,
			verifySignatures: false,
		}),
	)
	const serializedTransaction = bs58.encode(bytes)

	let send = wallet.sendTransaction?.bind(wallet)
	if (!send) {
		const { SolanaWallet } = await import("@crossmint/client-sdk-react-ui")
		const solana = SolanaWallet.from(
			wallet as Parameters<typeof SolanaWallet.from>[0],
		)
		send = (params) => solana.sendTransaction(params)
	}

	const result = await send({ serializedTransaction })
	const hash = result.hash?.trim()
	if (!hash) {
		throw new Error(
			"FlexiPay wallet submitted the transfer but returned no signature.",
		)
	}
	return hash
}
