import { describe, expect, it, vi } from "vitest";
import {
	ASSOCIATED_TOKEN_PROGRAM_ID,
	TOKEN_PROGRAM_ID,
	decodeTransferCheckedInstruction,
} from "@solana/spl-token";
import { Keypair, type Connection } from "@solana/web3.js";
import {
	ataFor,
	buildUsdcTransferTransaction,
	getSolAndUsdcBalances,
	PublicKey,
} from "../src/build-transfer.ts";

const payer = Keypair.generate().publicKey.toBase58();
const recipient = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
const reference = Keypair.generate().publicKey.toBase58();
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

function fakeConnection(overrides: Record<string, unknown> = {}) {
	return {
		getLatestBlockhash: vi.fn(async () => ({
			blockhash: BLOCKHASH,
			lastValidBlockHeight: 1234,
		})),
		getBalance: vi.fn(async () => 5_000_000),
		getTokenAccountBalance: vi.fn(async () => ({
			value: { amount: "2500000", decimals: 6, uiAmount: 2.5 },
		})),
		...overrides,
	} as unknown as Connection;
}

const base = () => ({
	connection: fakeConnection(),
	payer,
	recipientOwner: recipient,
	mint,
	amountMinor: 1n,
	decimals: 6,
});

describe("buildUsdcTransferTransaction", () => {
	it("builds ATA-create + transferChecked at the mint decimals", async () => {
		const connection = fakeConnection();
		const built = await buildUsdcTransferTransaction({
			...base(),
			connection,
			amountMinor: 995_000n,
		});
		const mintKey = new PublicKey(mint);
		expect(built.sourceAta).toBe(ataFor(mintKey, new PublicKey(payer)).toBase58());
		expect(built.destinationAta).toBe(
			ataFor(mintKey, new PublicKey(recipient)).toBase58(),
		);
		expect(built.instructions).toHaveLength(2);
		const [ataIx, transferIx] = built.instructions;
		expect(ataIx!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
		// CreateIdempotent discriminator = 1 (safe when the recipient ATA already exists).
		expect(ataIx!.data[0]).toBe(1);
		expect(transferIx!.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
		const decoded = decodeTransferCheckedInstruction(transferIx!);
		expect(decoded.data.amount).toBe(995_000n);
		expect(decoded.data.decimals).toBe(6);
		expect(decoded.keys.source.pubkey.toBase58()).toBe(built.sourceAta);
		expect(decoded.keys.destination.pubkey.toBase58()).toBe(built.destinationAta);
		expect(decoded.keys.mint.pubkey.toBase58()).toBe(mint);
		expect(decoded.keys.owner.pubkey.toBase58()).toBe(payer);
		expect(decoded.keys.owner.isSigner).toBe(true);
		expect(transferIx!.keys).toHaveLength(4);

		expect(built.transaction.feePayer?.toBase58()).toBe(payer);
		expect(built.transaction.recentBlockhash).toBe(BLOCKHASH);
		expect(built.transaction.lastValidBlockHeight).toBe(1234);
		expect(built.transaction.signatures.every((s) => s.signature === null)).toBe(true);
		expect(connection.getLatestBlockhash).toHaveBeenCalledWith("confirmed");
	});

	it("uses whatever decimals the mint has (tGBP at 2 decimals)", async () => {
		const built = await buildUsdcTransferTransaction({
			...base(),
			amountMinor: 1050n,
			decimals: 2,
		});
		const decoded = decodeTransferCheckedInstruction(built.instructions[1]!);
		expect(decoded.data.amount).toBe(1050n);
		expect(decoded.data.decimals).toBe(2);
	});

	it("appends the Solana Pay reference as a read-only non-signer key", async () => {
		const built = await buildUsdcTransferTransaction({ ...base(), reference });
		const keys = built.instructions[1]!.keys;
		expect(keys).toHaveLength(5);
		expect(keys[4]).toEqual({
			pubkey: new PublicKey(reference),
			isSigner: false,
			isWritable: false,
		});
		const msgKeys = built.transaction
			.compileMessage()
			.accountKeys.map((k) => k.toBase58());
		expect(msgKeys).toContain(reference);
	});

	it("supports off-curve (smart wallet) recipients", async () => {
		const smartWallet = "GjsyKr9wKg9yCJ1a98Luqvf6J6isqTpqtYSrY1Y7jwRg";
		const built = await buildUsdcTransferTransaction({
			...base(),
			recipientOwner: smartWallet,
		});
		expect(built.destinationAta).toBe(
			ataFor(new PublicKey(mint), new PublicKey(smartWallet)).toBase58(),
		);
	});

	it.each([0n, -5n])(
		"rejects non-positive amount %s before any RPC call",
		async (amountMinor) => {
			const connection = fakeConnection();
			await expect(
				buildUsdcTransferTransaction({ ...base(), connection, amountMinor }),
			).rejects.toThrow(/must be positive/);
			expect(connection.getLatestBlockhash).not.toHaveBeenCalled();
		},
	);

	it.each([
		["payer", { payer: "bad" }],
		["recipientOwner", { recipientOwner: "bad" }],
		["mint", { mint: "bad" }],
		["reference", { reference: "bad" }],
	])("rejects an invalid %s address", async (_name, patch) => {
		await expect(
			buildUsdcTransferTransaction({ ...base(), ...patch }),
		).rejects.toThrow(/invalid Solana address/);
	});

	it("propagates blockhash RPC failures", async () => {
		const connection = fakeConnection({
			getLatestBlockhash: vi.fn(async () => {
				throw new Error("rpc down");
			}),
		});
		await expect(
			buildUsdcTransferTransaction({ ...base(), connection }),
		).rejects.toThrow("rpc down");
	});
});

describe("getSolAndUsdcBalances", () => {
	it("reads SOL lamports and the owner's ATA balance", async () => {
		const connection = fakeConnection();
		const res = await getSolAndUsdcBalances(connection, payer, mint);
		expect(res).toEqual({ solLamports: 5_000_000n, usdcMinor: 2_500_000n });
		const ata = ataFor(new PublicKey(mint), new PublicKey(payer));
		const calledWith = vi.mocked(connection.getTokenAccountBalance).mock.calls[0]!;
		expect((calledWith[0] as PublicKey).equals(ata)).toBe(true);
		expect(calledWith[1]).toBe("confirmed");
	});

	it("returns 0 token balance when the ATA does not exist", async () => {
		const connection = fakeConnection({
			getTokenAccountBalance: vi.fn(async () => {
				throw new Error("could not find account");
			}),
		});
		const res = await getSolAndUsdcBalances(connection, payer, mint);
		expect(res).toEqual({ solLamports: 5_000_000n, usdcMinor: 0n });
	});

	it("rejects invalid owner or mint", async () => {
		await expect(getSolAndUsdcBalances(fakeConnection(), "x", mint)).rejects.toThrow(
			/invalid Solana address/,
		);
		await expect(getSolAndUsdcBalances(fakeConnection(), payer, "y")).rejects.toThrow(
			/invalid Solana address/,
		);
	});
});
