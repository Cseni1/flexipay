import { Keypair, Transaction, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
	connectionAsRefundRpc,
	loadTreasuryRefundSigner,
	prepareTreasuryRefund,
	refundSignatureStatus,
	sendPreparedTreasuryRefund,
	treasuryRefundSignerFromEnv,
	type SolanaRefundRpc,
} from "../src/refund.ts";

const treasury = Keypair.generate();
const payer = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
const blockhash = Keypair.generate().publicKey.toBase58();

function rpc(status: "confirmed" | "pending" | "failed"): SolanaRefundRpc {
	return {
		getLatestBlockhash: async () => ({
			blockhash,
			lastValidBlockHeight: 100,
		}),
		getBlockHeight: async () => 1,
		getSignatureStatuses: async (signatures) => ({
			value: signatures.map(() =>
				status === "pending"
					? null
					: {
							confirmationStatus: status === "confirmed" ? "confirmed" : null,
							err: status === "failed" ? { InstructionError: [0, "x"] } : null,
						},
			),
		}),
		sendRawTransaction: async () => "ignored",
	};
}

describe("treasury refund", () => {
	it("requires the JSON byte array and refuses a different treasury", () => {
		const env = {
			FP_SOLANA_SETTLE_TREASURY_SECRET: JSON.stringify([
				...treasury.secretKey,
			]),
		};
		expect(treasuryRefundSignerFromEnv(env).publicKey.toBase58()).toBe(
			treasury.publicKey.toBase58(),
		);
		expect(() => treasuryRefundSignerFromEnv({})).toThrow(/SECRET is required/);
		expect(() =>
			treasuryRefundSignerFromEnv({
				FP_SOLANA_SETTLE_TREASURY_SECRET: "not-json",
			}),
		).toThrow(/JSON array of 64 byte values/);
		expect(() =>
			treasuryRefundSignerFromEnv({
				FP_SOLANA_SETTLE_TREASURY_SECRET: "[1,2,3]",
			}),
		).toThrow(/64 byte values/);
	});

	it("loads the signer only for the expected treasury", () => {
		const env = {
			FP_SOLANA_SETTLE_TREASURY_SECRET: JSON.stringify([
				...treasury.secretKey,
			]),
		};
		expect(
			loadTreasuryRefundSigner(env, treasury.publicKey.toBase58()).publicKey.toBase58(),
		).toBe(treasury.publicKey.toBase58());
		expect(() =>
			loadTreasuryRefundSigner(
				env,
				Keypair.generate().publicKey.toBase58(),
			),
		).toThrow(/does not match FP_SOLANA_SETTLE_TREASURY/);
	});

	it("adapts a Connection to the refund RPC surface", async () => {
		const calls: unknown[] = [];
		const connection = {
			getLatestBlockhash: async (commitment: string) => {
				calls.push(["blockhash", commitment]);
				return { blockhash, lastValidBlockHeight: 100 };
			},
			getBlockHeight: async (commitment: string) => {
				calls.push(["height", commitment]);
				return 5;
			},
			getSignatureStatuses: async (
				signatures: string[],
				options: unknown,
			) => {
				calls.push(["statuses", signatures, options]);
				return {
					value: [
						{ confirmationStatus: "confirmed" as const, err: null },
						null,
					],
				};
			},
			sendRawTransaction: async (raw: Uint8Array, options: unknown) => {
				calls.push(["send", [...raw], options]);
				return "sig";
			},
		} as unknown as Connection;

		const rpc = connectionAsRefundRpc(connection);
		expect(await rpc.getLatestBlockhash()).toEqual({
			blockhash,
			lastValidBlockHeight: 100,
		});
		expect(await rpc.getBlockHeight()).toBe(5);
		expect(await rpc.getSignatureStatuses(["a", "b"])).toEqual({
			value: [
				{ confirmationStatus: "confirmed", err: null },
				null,
			],
		});
		await rpc.sendRawTransaction(new Uint8Array([1, 2]));
		expect(calls).toEqual([
			["blockhash", "confirmed"],
			["height", "confirmed"],
			[
				"statuses",
				["a", "b"],
				{ searchTransactionHistory: true },
			],
			["send", [1, 2], { preflightCommitment: "confirmed" }],
		]);
	});

	it("sends exactly the persisted signed bytes", async () => {
		let sent: Uint8Array | null = null;
		const prepared = await prepareTreasuryRefund({
			rpc: rpc("pending"),
			signer: treasury,
			payer,
			mint,
			amountMinor: 123n,
			decimals: 6,
		});
		await sendPreparedTreasuryRefund(
			{
				...rpc("pending"),
				sendRawTransaction: async (raw) => {
					sent = Uint8Array.from(raw);
					return prepared.signature;
				},
			},
			prepared.signedTransaction,
		);
		expect(sent).not.toBeNull();
		expect(Buffer.from(sent!).toString("base64")).toBe(
			prepared.signedTransaction,
		);
	});

	it("rejects non-positive amounts and invalid decimals", async () => {
		const base = {
			rpc: rpc("confirmed"),
			signer: treasury,
			payer,
			mint,
			amountMinor: 1n,
			decimals: 6,
		};
		await expect(
			prepareTreasuryRefund({ ...base, amountMinor: 0n }),
		).rejects.toThrow(/positive/);
		await expect(
			prepareTreasuryRefund({ ...base, decimals: 10 }),
		).rejects.toThrow(/0–9/);
	});

	it("builds a transferChecked refund from treasury to the original payer", async () => {
		const prepared = await prepareTreasuryRefund({
			rpc: rpc("confirmed"),
			signer: treasury,
			payer,
			mint,
			amountMinor: 12_345_678n,
			decimals: 6,
			reference: Keypair.generate().publicKey.toBase58(),
		});
		expect(prepared.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{40,90}$/);
		const tx = Transaction.from(
			Buffer.from(prepared.signedTransaction, "base64"),
		);
		expect(tx.feePayer?.toBase58()).toBe(treasury.publicKey.toBase58());
		expect(tx.instructions).toHaveLength(2);
		expect(tx.verifySignatures()).toBe(true);
	});

	it("only reports confirmed after a successful confirmed signature", async () => {
		expect(await refundSignatureStatus(rpc("confirmed"), "sig")).toBe(
			"confirmed",
		);
		expect(await refundSignatureStatus(rpc("pending"), "sig")).toBe("pending");
		expect(await refundSignatureStatus(rpc("failed"), "sig")).toBe("failed");
	});
});
