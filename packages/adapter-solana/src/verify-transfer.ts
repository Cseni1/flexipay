import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
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
};

export type TransferVerifyOk = {
	ok: true;
	signature: string;
	amountMinor: bigint;
	mint: string;
	recipientOwner: string;
	slot: number;
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
 * Independently verifies a confirmed SPL USDC transfer to `recipientOwner`.
 * Never treats “submitted” as success — requires successful meta + matching balance delta or parsed ix.
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
		};
	}

	const fromIx = amountFromParsedInstructions(
		tx,
		mint,
		recipientOwner,
		input.usdcDecimals,
	);
	if (fromIx !== null) {
		if (fromIx < input.amountMinor) {
			return {
				ok: false,
				reason: "amount_too_low",
				message: `Instruction amount ${fromIx.toString()} below expected ${input.amountMinor.toString()}`,
			};
		}
		return {
			ok: true,
			signature: input.signature,
			amountMinor: fromIx,
			mint,
			recipientOwner,
			slot: tx.slot,
		};
	}

	const mintTouched = [...pre, ...post].some((row) => row.mint === mint);
	if (mintTouched) {
		return {
			ok: false,
			reason: "wrong_recipient",
			message: "USDC mint moved but not to the expected recipient owner",
		};
	}
	return {
		ok: false,
		reason: "no_token_transfer",
		message: "No matching SPL USDC transfer found in the transaction",
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

function amountFromParsedInstructions(
	tx: ParsedTransactionWithMeta,
	mint: string,
	recipientOwner: string,
	decimals: number,
): bigint | null {
	let total = 0n;
	let matched = false;

	for (const ix of tx.transaction.message.instructions) {
		if (!("programId" in ix)) continue;
		const programId =
			typeof ix.programId === "string" ? ix.programId : ix.programId.toBase58();
		if (programId !== TOKEN_PROGRAM_ID.toBase58()) continue;
		if (!("parsed" in ix) || !ix.parsed || typeof ix.parsed !== "object") continue;

		const parsed = ix.parsed as {
			type?: string;
			info?: Record<string, unknown>;
		};
		if (parsed.type !== "transfer" && parsed.type !== "transferChecked") continue;
		const info = parsed.info ?? {};
		const ixMint = info.mint ? String(info.mint) : mint;
		if (ixMint !== mint) continue;

		const destination = String(info.destination ?? "");
		const destOwner = ownerOfTokenAccount(tx, destination);
		if (destOwner !== recipientOwner) continue;

		const amountStr =
			typeof info.tokenAmount === "object" &&
			info.tokenAmount &&
			"amount" in (info.tokenAmount as object)
				? String((info.tokenAmount as { amount: string }).amount)
				: String(info.amount ?? "0");
		if (
			parsed.type === "transferChecked" &&
			typeof info.decimals === "number" &&
			info.decimals !== decimals
		) {
			continue;
		}
		total += BigInt(amountStr);
		matched = true;
	}
	return matched ? total : null;
}

function ownerOfTokenAccount(
	tx: ParsedTransactionWithMeta,
	tokenAccount: string,
): string | undefined {
	const post = (tx.meta?.postTokenBalances ?? []) as TokenBalance[];
	const keys = tx.transaction.message.accountKeys.map((k) =>
		typeof k === "string" ? k : k.pubkey.toBase58(),
	);
	for (const row of post) {
		const idx = row.accountIndex;
		if (typeof idx === "number" && keys[idx] === tokenAccount) {
			return row.owner;
		}
	}
	return undefined;
}
