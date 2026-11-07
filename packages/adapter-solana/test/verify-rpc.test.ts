import { describe, expect, it, vi } from "vitest";
import { Keypair, type Connection } from "@solana/web3.js";
import {
	connectionAsRpc,
	evaluateParsedTransfer,
	verifyUsdcTransfer,
	type SolanaRpc,
} from "../src/verify-transfer.ts";

const mint = Keypair.generate().publicKey.toBase58();
const otherMint = Keypair.generate().publicKey.toBase58();
const recipient = Keypair.generate().publicKey.toBase58();
const sender = Keypair.generate().publicKey.toBase58();
const reference = Keypair.generate().publicKey;

type Row = { mint: string; owner?: string; amount: string };
const bal = (rows: Row[]) =>
	rows.map((r, i) => ({
		accountIndex: i,
		mint: r.mint,
		owner: r.owner,
		uiTokenAmount: { amount: r.amount, decimals: 6 },
	}));

function tx(opts: {
	pre?: Row[];
	post?: Row[];
	blockTime?: number | null;
	keys?: unknown[];
	err?: unknown;
}) {
	return {
		slot: 7,
		blockTime: opts.blockTime === undefined ? 1_700_000_100 : opts.blockTime,
		transaction: {
			message: { accountKeys: opts.keys ?? [recipient, mint], instructions: [] },
		},
		meta: {
			err: opts.err ?? null,
			preTokenBalances: bal(
				opts.pre ?? [
					{ mint, owner: recipient, amount: "0" },
					{ mint, owner: sender, amount: "5000000" },
				],
			),
			postTokenBalances: bal(
				opts.post ?? [
					{ mint, owner: recipient, amount: "1000000" },
					{ mint, owner: sender, amount: "4000000" },
				],
			),
		},
	} as never;
}

const rpcReturning = (value: unknown): SolanaRpc => ({
	getParsedTransaction: vi.fn(async () => value as never),
});

const input = {
	signature: "sig1",
	mint,
	recipientOwner: recipient,
	amountMinor: 1_000_000n,
	usdcDecimals: 6,
};

const reasonOf = (r: { ok: boolean; reason?: string }) => (r.ok ? "ok" : r.reason);

describe("verifyUsdcTransfer (RPC wrapper)", () => {
	it("verifies a confirmed transfer and reports payer/slot/blockTime", async () => {
		const rpc = rpcReturning(tx({}));
		const res = await verifyUsdcTransfer(rpc, input);
		expect(res).toEqual({
			ok: true,
			signature: "sig1",
			amountMinor: 1_000_000n,
			mint,
			recipientOwner: recipient,
			payer: sender,
			slot: 7,
			blockTime: 1_700_000_100,
		});
		expect(rpc.getParsedTransaction).toHaveBeenCalledWith("sig1");
	});

	it("not found (null) maps to not_found so callers keep the payment pending", async () => {
		const res = await verifyUsdcTransfer(rpcReturning(null), input);
		expect(reasonOf(res)).toBe("not_found");
	});

	it("RPC throw maps to rpc_error with the message", async () => {
		const rpc: SolanaRpc = {
			getParsedTransaction: async () => {
				throw new Error("429 Too Many Requests");
			},
		};
		const res = await verifyUsdcTransfer(rpc, input);
		expect(res).toEqual({ ok: false, reason: "rpc_error", message: "429 Too Many Requests" });
	});

	it("non-Error RPC throw gets a generic message", async () => {
		const rpc: SolanaRpc = {
			getParsedTransaction: async () => {
				throw "boom";
			},
		};
		const res = await verifyUsdcTransfer(rpc, input);
		expect(res).toEqual({ ok: false, reason: "rpc_error", message: "RPC error" });
	});

	it("rejects invalid mint / recipient before calling RPC", async () => {
		const rpc = rpcReturning(tx({}));
		await expect(verifyUsdcTransfer(rpc, { ...input, mint: "nope" })).rejects.toThrow(
			/invalid Solana address/,
		);
		await expect(
			verifyUsdcTransfer(rpc, { ...input, recipientOwner: "nope" }),
		).rejects.toThrow(/invalid Solana address/);
		expect(rpc.getParsedTransaction).not.toHaveBeenCalled();
	});

	it("passes reference and notBeforeUnix through to evaluation", async () => {
		const stale = await verifyUsdcTransfer(rpcReturning(tx({ blockTime: 100 })), {
			...input,
			notBeforeUnix: 200,
		});
		expect(reasonOf(stale)).toBe("stale_transaction");
		const noRef = await verifyUsdcTransfer(rpcReturning(tx({})), {
			...input,
			reference: reference.toBase58(),
		});
		expect(reasonOf(noRef)).toBe("missing_reference");
	});

	it("wrong mint via RPC path", async () => {
		const res = await verifyUsdcTransfer(
			rpcReturning(
				tx({
					pre: [{ mint: otherMint, owner: recipient, amount: "0" }],
					post: [{ mint: otherMint, owner: recipient, amount: "1000000" }],
				}),
			),
			input,
		);
		expect(reasonOf(res)).toBe("wrong_mint");
	});

	it("wrong recipient via RPC path", async () => {
		const res = await verifyUsdcTransfer(rpcReturning(tx({})), {
			...input,
			recipientOwner: Keypair.generate().publicKey.toBase58(),
		});
		expect(reasonOf(res)).toBe("wrong_recipient");
	});

	it("failed on-chain via RPC path", async () => {
		const res = await verifyUsdcTransfer(
			rpcReturning(tx({ err: { InstructionError: [1, { Custom: 1 }] } })),
			input,
		);
		expect(reasonOf(res)).toBe("failed_on_chain");
	});

	it("wrong amount (below expected) is amount_too_low", async () => {
		const res = await verifyUsdcTransfer(rpcReturning(tx({})), {
			...input,
			amountMinor: 1_000_001n,
		});
		expect(reasonOf(res)).toBe("amount_too_low");
	});

	it("overpayment is accepted and reports the actual delta", async () => {
		const res = await verifyUsdcTransfer(rpcReturning(tx({})), {
			...input,
			amountMinor: 1n,
		});
		expect(res.ok && res.amountMinor).toBe(1_000_000n);
	});
});

describe("connectionAsRpc", () => {
	it("calls getParsedTransaction with v0 support at confirmed commitment", async () => {
		const getParsedTransaction = vi.fn(async () => null);
		const rpc = connectionAsRpc({ getParsedTransaction } as unknown as Connection);
		await rpc.getParsedTransaction("abc");
		expect(getParsedTransaction).toHaveBeenCalledWith("abc", {
			maxSupportedTransactionVersion: 0,
			commitment: "confirmed",
		});
	});
});

describe("evaluateParsedTransfer edge cases", () => {
	it("missing blockTime with notBeforeUnix stays not_found (retry later)", () => {
		const res = evaluateParsedTransfer(tx({ blockTime: null }), {
			...input,
			notBeforeUnix: 1,
		});
		expect(reasonOf(res)).toBe("not_found");
	});

	it("missing blockTime without notBeforeUnix is still accepted with blockTime null", () => {
		const res = evaluateParsedTransfer(tx({ blockTime: null }), input);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.blockTime).toBeNull();
	});

	it("blockTime equal to notBeforeUnix is not stale", () => {
		const res = evaluateParsedTransfer(tx({ blockTime: 500 }), { ...input, notBeforeUnix: 500 });
		expect(res.ok).toBe(true);
	});

	it("accepts reference present as a parsed account key object", () => {
		const res = evaluateParsedTransfer(
			tx({ keys: [{ pubkey: Keypair.generate().publicKey }, { pubkey: reference }] }),
			{ ...input, reference: reference.toBase58() },
		);
		expect(res.ok).toBe(true);
	});

	it("rejects an invalid reference address", () => {
		expect(() => evaluateParsedTransfer(tx({}), { ...input, reference: "bad" })).toThrow(
			/invalid Solana address/,
		);
	});

	it("new recipient ATA (no pre row) counts the full post balance", () => {
		const res = evaluateParsedTransfer(
			tx({
				pre: [{ mint, owner: sender, amount: "5000000" }],
				post: [
					{ mint, owner: recipient, amount: "1000000" },
					{ mint, owner: sender, amount: "4000000" },
				],
			}),
			input,
		);
		expect(res.ok && res.amountMinor).toBe(1_000_000n);
	});

	it("sums multiple token accounts of the recipient for the mint", () => {
		const res = evaluateParsedTransfer(
			tx({
				pre: [
					{ mint, owner: recipient, amount: "10" },
					{ mint, owner: recipient, amount: "20" },
				],
				post: [
					{ mint, owner: recipient, amount: "510" },
					{ mint, owner: recipient, amount: "520" },
				],
			}),
			{ ...input, amountMinor: 1000n },
		);
		expect(res.ok && res.amountMinor).toBe(1000n);
	});

	it("recipient balance decrease of the mint is wrong_recipient, not success", () => {
		const res = evaluateParsedTransfer(
			tx({
				pre: [{ mint, owner: recipient, amount: "1000" }],
				post: [{ mint, owner: recipient, amount: "0" }],
			}),
			{ ...input, amountMinor: 1n },
		);
		expect(reasonOf(res)).toBe("wrong_recipient");
	});

	it("no token balances at all is no_token_transfer", () => {
		const res = evaluateParsedTransfer(tx({ pre: [], post: [] }), input);
		expect(reasonOf(res)).toBe("no_token_transfer");
	});

	it("missing meta is treated as no_token_transfer", () => {
		const res = evaluateParsedTransfer(
			{
				slot: 1,
				blockTime: 1,
				transaction: { message: { accountKeys: [], instructions: [] } },
				meta: null,
			} as never,
			input,
		);
		expect(reasonOf(res)).toBe("no_token_transfer");
	});

	it("rows without owner are ignored for the recipient and payer", () => {
		const res = evaluateParsedTransfer(
			tx({
				pre: [
					{ mint, owner: recipient, amount: "0" },
					{ mint, amount: "900" },
				],
				post: [
					{ mint, owner: recipient, amount: "100" },
					{ mint, amount: "800" },
				],
			}),
			{ ...input, amountMinor: 100n },
		);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.payer).toBeNull();
	});

	it("payer is the owner whose balance fell the most", () => {
		const second = Keypair.generate().publicKey.toBase58();
		const res = evaluateParsedTransfer(
			tx({
				pre: [
					{ mint, owner: recipient, amount: "0" },
					{ mint, owner: sender, amount: "100" },
					{ mint, owner: second, amount: "1000" },
				],
				post: [
					{ mint, owner: recipient, amount: "1000" },
					{ mint, owner: sender, amount: "90" },
					{ mint, owner: second, amount: "10" },
				],
			}),
			{ ...input, amountMinor: 1000n },
		);
		expect(res.ok && res.payer).toBe(second);
	});
});
