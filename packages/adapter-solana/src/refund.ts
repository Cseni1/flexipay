import {
	createAssociatedTokenAccountIdempotentInstruction,
	createTransferCheckedInstruction,
	getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
	Connection,
	Keypair,
	Transaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { parseSolanaAddress } from "./address.ts";

/**
 * Minimal RPC surface needed to build, send and confirm a treasury refund. Kept narrow so API
 * tests can replace the RPC without a network or a live treasury.
 */
export interface SolanaRefundRpc {
	getLatestBlockhash(): Promise<{
		blockhash: string;
		lastValidBlockHeight: number;
	}>;
	getBlockHeight(): Promise<number>;
	getSignatureStatuses(signatures: string[]): Promise<{
		value: Array<{
			confirmationStatus?: "processed" | "confirmed" | "finalized" | null;
			err: unknown;
		} | null>;
	}>;
	sendRawTransaction(rawTransaction: Uint8Array): Promise<string>;
}

export function connectionAsRefundRpc(connection: Connection): SolanaRefundRpc {
	return {
		getLatestBlockhash: () => connection.getLatestBlockhash("confirmed"),
		getBlockHeight: () => connection.getBlockHeight("confirmed"),
		getSignatureStatuses: async (signatures) => {
			const result = await connection.getSignatureStatuses(signatures, {
				searchTransactionHistory: true,
			});
			return {
				value: result.value.map((status) =>
					status
						? {
								confirmationStatus: status.confirmationStatus,
								err: status.err,
							}
						: null,
				),
			};
		},
		sendRawTransaction: (rawTransaction) =>
			connection.sendRawTransaction(rawTransaction, {
				preflightCommitment: "confirmed",
			}),
	};
}

/**
 * The treasury keypair is supplied only as the 64-byte JSON array used by Solana tooling.
 * The public address must be checked against FP_SOLANA_SETTLE_TREASURY before any refund.
 */
export function treasuryRefundSignerFromEnv(
	env: Record<string, string | undefined> = process.env,
): Keypair {
	const raw = env.FP_SOLANA_SETTLE_TREASURY_SECRET?.trim();
	if (!raw) {
		throw new Error(
			"FP_SOLANA_SETTLE_TREASURY_SECRET is required to refund a Solana settle",
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(
			"FP_SOLANA_SETTLE_TREASURY_SECRET must be a JSON array of 64 byte values",
		);
	}
	if (
		!Array.isArray(parsed) ||
		parsed.length !== 64 ||
		parsed.some(
			(value) =>
				typeof value !== "number" ||
				!Number.isInteger(value) ||
				value < 0 ||
				value > 255,
		)
	) {
		throw new Error(
			"FP_SOLANA_SETTLE_TREASURY_SECRET must be a JSON array of 64 byte values",
		);
	}
	return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
}

/** Refuse to sign with a key that is not the configured settle treasury. */
export function assertTreasuryRefundSigner(
	signer: Keypair,
	expectedTreasury: string,
): void {
	const expected = parseSolanaAddress(expectedTreasury).toBase58();
	if (signer.publicKey.toBase58() !== expected) {
		throw new Error(
			"FP_SOLANA_SETTLE_TREASURY_SECRET does not match FP_SOLANA_SETTLE_TREASURY; refunds are disabled",
		);
	}
}

export function loadTreasuryRefundSigner(
	env: Record<string, string | undefined>,
	expectedTreasury: string,
): Keypair {
	const signer = treasuryRefundSignerFromEnv(env);
	assertTreasuryRefundSigner(signer, expectedTreasury);
	return signer;
}

export type PreparedTreasuryRefund = {
	/** Base58 transaction signature. Persist this before sending. */
	signature: string;
	/** Base64 signed transaction; resending the same bytes can never create a second transfer. */
	signedTransaction: string;
	lastValidBlockHeight: number;
};

/**
 * Builds and signs an SPL transferChecked refund from the treasury back to the original payer.
 * The optional reference is a read-only key that makes otherwise identical refunds distinct.
 */
export async function prepareTreasuryRefund(input: {
	rpc: SolanaRefundRpc;
	signer: Keypair;
	payer: string;
	mint: string;
	amountMinor: bigint;
	decimals: number;
	reference?: string;
}): Promise<PreparedTreasuryRefund> {
	if (input.amountMinor <= 0n) {
		throw new Error("refund amount must be positive");
	}
	if (
		!Number.isInteger(input.decimals) ||
		input.decimals < 0 ||
		input.decimals > 9
	) {
		throw new Error("refund mint decimals must be an integer 0–9");
	}
	const payer = parseSolanaAddress(input.payer);
	const mint = parseSolanaAddress(input.mint);
	const treasury = input.signer.publicKey;
	const sourceAta = getAssociatedTokenAddressSync(mint, treasury, true);
	const destinationAta = getAssociatedTokenAddressSync(mint, payer, true);

	const transfer = createTransferCheckedInstruction(
		sourceAta,
		mint,
		destinationAta,
		treasury,
		input.amountMinor,
		input.decimals,
	);
	if (input.reference) {
		transfer.keys.push({
			pubkey: parseSolanaAddress(input.reference),
			isSigner: false,
			isWritable: false,
		});
	}

	const { blockhash, lastValidBlockHeight } =
		await input.rpc.getLatestBlockhash();
	const transaction = new Transaction({
		feePayer: treasury,
		blockhash,
		lastValidBlockHeight,
	}).add(
		createAssociatedTokenAccountIdempotentInstruction(
			treasury,
			destinationAta,
			payer,
			mint,
		),
		transfer,
	);
	transaction.sign(input.signer);
	if (!transaction.signature) {
		throw new Error("refund transaction was not signed");
	}
	return {
		signature: bs58.encode(transaction.signature),
		signedTransaction: Buffer.from(transaction.serialize()).toString("base64"),
		lastValidBlockHeight,
	};
}

/** Re-sends exactly the persisted signed bytes; the signature is the idempotency key. */
export async function sendPreparedTreasuryRefund(
	rpc: SolanaRefundRpc,
	signedTransaction: string,
): Promise<void> {
	await rpc.sendRawTransaction(Buffer.from(signedTransaction, "base64"));
}

export type TreasuryRefundStatus = "confirmed" | "failed" | "pending";

/** Checks the chain before any resend; only a confirmed, successful tx settles a refund. */
export async function refundSignatureStatus(
	rpc: SolanaRefundRpc,
	signature: string,
): Promise<TreasuryRefundStatus> {
	const result = await rpc.getSignatureStatuses([signature]);
	const status = result.value[0];
	if (!status) return "pending";
	if (status.err) return "failed";
	if (
		status.confirmationStatus === "confirmed" ||
		status.confirmationStatus === "finalized"
	) {
		return "confirmed";
	}
	return "pending";
}
