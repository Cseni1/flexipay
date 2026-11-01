import {
	createAssociatedTokenAccountIdempotentInstruction,
	createTransferCheckedInstruction,
	getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
	Connection,
	PublicKey,
	Transaction,
	type TransactionInstruction,
} from "@solana/web3.js";
import { parseSolanaAddress } from "./address.ts";

export type BuildUsdcTransferInput = {
	connection: Connection;
	payer: string;
	recipientOwner: string;
	mint: string;
	amountMinor: bigint;
	decimals: number;
};

export type BuiltUsdcTransfer = {
	transaction: Transaction;
	sourceAta: string;
	destinationAta: string;
	instructions: TransactionInstruction[];
};

/**
 * Builds an unsigned SPL Token transferChecked (+ ATA create if needed) for the sender wallet to sign.
 * Does not broadcast. Fee payer = sender (`payer`).
 */
export async function buildUsdcTransferTransaction(
	input: BuildUsdcTransferInput,
): Promise<BuiltUsdcTransfer> {
	const payer = parseSolanaAddress(input.payer);
	const recipient = parseSolanaAddress(input.recipientOwner);
	const mint = parseSolanaAddress(input.mint);
	if (input.amountMinor <= 0n) {
		throw new Error("transfer amount must be positive");
	}

	const sourceAta = getAssociatedTokenAddressSync(mint, payer);
	const destinationAta = getAssociatedTokenAddressSync(mint, recipient);

	const instructions: TransactionInstruction[] = [
		createAssociatedTokenAccountIdempotentInstruction(
			payer,
			destinationAta,
			recipient,
			mint,
		),
		createTransferCheckedInstruction(
			sourceAta,
			mint,
			destinationAta,
			payer,
			input.amountMinor,
			input.decimals,
		),
	];

	const { blockhash, lastValidBlockHeight } =
		await input.connection.getLatestBlockhash("confirmed");
	const transaction = new Transaction({
		feePayer: payer,
		blockhash,
		lastValidBlockHeight,
	}).add(...instructions);

	return {
		transaction,
		sourceAta: sourceAta.toBase58(),
		destinationAta: destinationAta.toBase58(),
		instructions,
	};
}

export async function getSolAndUsdcBalances(
	connection: Connection,
	owner: string,
	mint: string,
): Promise<{ solLamports: bigint; usdcMinor: bigint }> {
	const ownerKey = parseSolanaAddress(owner);
	const mintKey = parseSolanaAddress(mint);
	const solLamports = BigInt(await connection.getBalance(ownerKey, "confirmed"));
	const ata = getAssociatedTokenAddressSync(mintKey, ownerKey);
	try {
		const bal = await connection.getTokenAccountBalance(ata, "confirmed");
		return { solLamports, usdcMinor: BigInt(bal.value.amount) };
	} catch {
		return { solLamports, usdcMinor: 0n };
	}
}

export { PublicKey, getAssociatedTokenAddressSync };
