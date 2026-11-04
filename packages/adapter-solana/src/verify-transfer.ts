import {
	Connection,
	type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { parseSolanaAddress } from "./address.ts";

export type TransferVerifyInput = {
	signature: string;
	mint: string;
	recipientOwner: string;
	/** Minimum accepted transferred amount in minor units. */
	amountMinor: bigint;
	usdcDecimals: number;
	/**
	 * Solana Pay reference pubkey that must appear as a read-only account key
	 * in the confirmed transaction (Lane B / F4).
	 */
	reference?: string;
	/**
	 * Unix seconds: reject transactions whose blockTime is strictly before this
	 * (intent issued-at). Missing blockTime is treated as not yet confirmable.
	 */
	notBeforeUnix?: number;
};

export type TransferVerifyOk = {
	ok: true;
	signature: string;
	amountMinor: bigint;
	mint: string;
	recipientOwner: string;
	slot: number;
	blockTime: number | null;
};

export type TransferVerifyFail = {
	ok: false;
	reason:
		| "not_found"
		| "failed_on_chain"
		| "wrong_mint"
		| "wrong_recipient"
		| "amount_too_low"
		| "no_token_transfer"
		| "missing_reference"
		| "stale_transaction"
		| "rpc_error";
	message: string;
};

export type TransferVerifyResult = TransferVerifyOk | TransferVerifyFail;

export interface SolanaRpc {
	getParsedTransaction(
		signature: string,
	): Promise<ParsedTransactionWithMeta | null>;
}

export function connectionAsRpc(connection: Connection): SolanaRpc {
	return {
		getParsedTransaction: (signature) =>
			connection.getParsedTransaction(signature, {
				maxSupportedTransactionVersion: 0,
				commitment: "confirmed",
			}),
	};
}

type TokenBalance = {
	accountIndex?: number;
	mint: string;
	owner?: string;
	uiTokenAmount: { amount: string; decimals: number };
};

/**
 * Independently verifies a confirmed SPL transfer (USDC or TGBP, by the mint passed in) to `recipientOwner`.
 * Verification is mint-scoped balance delta only (Lane B / F3) — no instruction
 * fallback that could treat a mint-less SPL `transfer` as the expected mint.
 */
export async function verifyUsdcTransfer(
	rpc: SolanaRpc,
	input: TransferVerifyInput,
): Promise<TransferVerifyResult> {
	const mint = parseSolanaAddress(input.mint).toBase58();
	const recipientOwner = parseSolanaAddress(input.recipientOwner).toBase58();

	let tx: ParsedTransactionWithMeta | null;
	try {
		tx = await rpc.getParsedTransaction(input.signature);
	} catch (cause) {
		return {
			ok: false,
			reason: "rpc_error",
			message: cause instanceof Error ? cause.message : "RPC error",
		};
	}
	if (!tx) {
		return {
			ok: false,
			reason: "not_found",
			message: "Transaction not found or not yet confirmed",
		};
	}
	return evaluateParsedTransfer(tx, {
		signature: input.signature,
		mint,
		recipientOwner,
		amountMinor: input.amountMinor,
		usdcDecimals: input.usdcDecimals,
		reference: input.reference,
		notBeforeUnix: input.notBeforeUnix,
	});
}

/** Pure evaluation for unit tests with fixture transactions. */
export function evaluateParsedTransfer(
	tx: ParsedTransactionWithMeta,
	input: {
		signature: string;
		mint: string;
		recipientOwner: string;
		amountMinor: bigint;
		usdcDecimals: number;
		reference?: string;
		notBeforeUnix?: number;
	},
): TransferVerifyResult {
	const mint = parseSolanaAddress(input.mint).toBase58();
	const recipientOwner = parseSolanaAddress(input.recipientOwner).toBase58();

	if (tx.meta?.err) {
		return {
			ok: false,
			reason: "failed_on_chain",
			message: `Transaction failed on-chain: ${JSON.stringify(tx.meta.err)}`,
		};
	}

	if (input.notBeforeUnix !== undefined) {
		const blockTime = tx.blockTime ?? null;
		if (blockTime === null) {
			return {
				ok: false,
				reason: "not_found",
				message: "Transaction has no blockTime yet; retry confirm",
			};
		}
		if (blockTime < input.notBeforeUnix) {
			return {
				ok: false,
				reason: "stale_transaction",
				message: `Transaction blockTime ${blockTime} is older than intent ${input.notBeforeUnix}`,
			};
		}
	}

	if (input.reference) {
		const reference = parseSolanaAddress(input.reference).toBase58();
		const keys = tx.transaction.message.accountKeys.map((k) =>
			typeof k === "string" ? k : k.pubkey.toBase58(),
		);
		if (!keys.includes(reference)) {
			return {
				ok: false,
				reason: "missing_reference",
				message: "Solana Pay reference account key is missing from the transaction",
			};
		}
	}

	const pre = (tx.meta?.preTokenBalances ?? []) as TokenBalance[];
	const post = (tx.meta?.postTokenBalances ?? []) as TokenBalance[];

	const delta = recipientMintDelta(pre, post, mint, recipientOwner);
	if (delta !== null) {
		if (delta < input.amountMinor) {
			return {
				ok: false,
				reason: "amount_too_low",
				message: `Recipient gained ${delta.toString()} minor units; expected at least ${input.amountMinor.toString()}`,
			};
		}
		return {
			ok: true,
			signature: input.signature,
			amountMinor: delta,
			mint,
			recipientOwner,
			slot: tx.slot,
			blockTime: tx.blockTime ?? null,
		};
	}

	const otherMintToRecipient = post.some(
		(row) =>
			(row.owner ?? "") === recipientOwner &&
			row.mint !== mint &&
			recipientMintDelta(pre, post, row.mint, recipientOwner) !== null,
	);
	if (otherMintToRecipient) {
		return {
			ok: false,
			reason: "wrong_mint",
			message: "Recipient gained a different token; expected the configured mint only",
		};
	}

	const mintTouched = [...pre, ...post].some((row) => row.mint === mint);
	if (mintTouched) {
		return {
			ok: false,
			reason: "wrong_recipient",
			message: "Configured mint moved but not to the expected recipient owner",
		};
	}
	return {
		ok: false,
		reason: "no_token_transfer",
		message: "No matching SPL transfer of the configured mint found in the transaction",
	};
}

function recipientMintDelta(
	pre: TokenBalance[],
	post: TokenBalance[],
	mint: string,
	owner: string,
): bigint | null {
	const preAmt = sumOwnerMint(pre, mint, owner);
	const postAmt = sumOwnerMint(post, mint, owner);
	if (preAmt === null && postAmt === null) return null;
	const delta = (postAmt ?? 0n) - (preAmt ?? 0n);
	return delta > 0n ? delta : null;
}

function sumOwnerMint(
	rows: TokenBalance[],
	mint: string,
	owner: string,
): bigint | null {
	let total: bigint | null = null;
	for (const row of rows) {
		if (row.mint !== mint) continue;
		if ((row.owner ?? "") !== owner) continue;
		const amt = BigInt(row.uiTokenAmount.amount);
		total = (total ?? 0n) + amt;
	}
	return total;
}
