import { Keypair, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
	assertTreasuryRefundSigner,
	prepareTreasuryRefund,
	refundSignatureStatus,
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
				FP_SOLANA_SETTLE_TREASURY_SECRET: "[1,2,3]",
			}),
		).toThrow(/64 byte values/);
	});

	it("refuses a secret for a different treasury", () => {
		expect(() =>
			assertTreasuryRefundSigner(
				Keypair.generate(),
				treasury.publicKey.toBase58(),
			),
		).toThrow(/does not match FP_SOLANA_SETTLE_TREASURY/);
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
