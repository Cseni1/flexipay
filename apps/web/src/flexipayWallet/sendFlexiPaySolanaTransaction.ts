import bs58 from "bs58"

type SendParams = { serializedTransaction: string }

type SendResult = {
	hash: string
	explorerLink?: string
	transactionId?: string
}

/** Minimal wallet shape used for FlexiPay Solana pay (Privy embedded wallet or the test stub). */
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
 * FlexiPay embedded Solana wallet as a base58-serialized payload.
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

	const send = wallet.sendTransaction?.bind(wallet)
	if (!send) {
		throw new Error("The FlexiPay wallet cannot send transactions yet.")
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
