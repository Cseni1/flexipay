import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { Keypair } from "@solana/web3.js";
import { evaluateParsedTransfer } from "../src/verify-transfer.ts";
import { isSolanaAddress } from "../src/address.ts";

const mint = Keypair.generate().publicKey.toBase58();
const otherMint = Keypair.generate().publicKey.toBase58();
const recipient = Keypair.generate().publicKey.toBase58();
const other = Keypair.generate().publicKey.toBase58();
const reference = Keypair.generate().publicKey.toBase58();

const baseTx = (overrides: Record<string, unknown> = {}) =>
	({
		slot: 42,
		blockTime: 1_700_000_100,
		transaction: {
			message: {
				accountKeys: [recipient, mint, reference],
				instructions: [],
			},
		},
		meta: {
			err: null,
			preTokenBalances: [
				{
					accountIndex: 0,
					mint,
					owner: recipient,
					uiTokenAmount: { amount: "100", decimals: 6 },
				},
			],
			postTokenBalances: [
				{
					accountIndex: 0,
					mint,
					owner: recipient,
					uiTokenAmount: { amount: "1100", decimals: 6 },
				},
			],
		},
		...overrides,
	}) as never;

describe("evaluateParsedTransfer", () => {
	test("accepts recipient balance increase for the mint", () => {
		const result = evaluateParsedTransfer(baseTx(), {
			signature: "sig-ok",
			mint,
			recipientOwner: recipient,
			amountMinor: 1000n,
			usdcDecimals: 6,
			reference,
		});
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.amountMinor, 1000n);
	});

	test("rejects failed on-chain meta", () => {
		const result = evaluateParsedTransfer(
			baseTx({
				meta: {
					err: { InstructionError: [0, "Custom"] },
					preTokenBalances: [],
					postTokenBalances: [],
				},
			}),
			{
				signature: "sig-fail",
				mint,
				recipientOwner: recipient,
				amountMinor: 1n,
				usdcDecimals: 6,
			},
		);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "failed_on_chain");
	});

	test("rejects wrong recipient", () => {
		const result = evaluateParsedTransfer(baseTx(), {
			signature: "sig-wrong",
			mint,
			recipientOwner: other,
			amountMinor: 1000n,
			usdcDecimals: 6,
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "wrong_recipient");
	});

	test("rejects amount too low", () => {
		const result = evaluateParsedTransfer(baseTx(), {
			signature: "sig-low",
			mint,
			recipientOwner: recipient,
			amountMinor: 5000n,
			usdcDecimals: 6,
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "amount_too_low");
	});

	test("F3: rejects non-USDC transfer even if instruction fallback would have matched", () => {
		const tx = baseTx({
			meta: {
				err: null,
				preTokenBalances: [
					{
						accountIndex: 0,
						mint: otherMint,
						owner: recipient,
						uiTokenAmount: { amount: "0", decimals: 6 },
					},
				],
				postTokenBalances: [
					{
						accountIndex: 0,
						mint: otherMint,
						owner: recipient,
						uiTokenAmount: { amount: "1000", decimals: 6 },
					},
				],
			},
			transaction: {
				message: {
					accountKeys: [recipient, otherMint],
					instructions: [
						{
							programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
							parsed: {
								type: "transfer",
								info: {
									destination: "ata-other",
									amount: "1000",
									// no mint field — old fallback would treat as expected mint
								},
							},
						},
					],
				},
			},
		});
		const result = evaluateParsedTransfer(tx, {
			signature: "sig-wrong-mint",
			mint,
			recipientOwner: recipient,
			amountMinor: 1000n,
			usdcDecimals: 6,
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "wrong_mint");
	});

	test("F3: USDC to someone else is wrong_recipient", () => {
		const tx = baseTx({
			meta: {
				err: null,
				preTokenBalances: [
					{
						accountIndex: 0,
						mint,
						owner: other,
						uiTokenAmount: { amount: "0", decimals: 6 },
					},
				],
				postTokenBalances: [
					{
						accountIndex: 0,
						mint,
						owner: other,
						uiTokenAmount: { amount: "1000", decimals: 6 },
					},
				],
			},
			transaction: {
				message: { accountKeys: [other, mint], instructions: [] },
			},
		});
		const result = evaluateParsedTransfer(tx, {
			signature: "sig-other-owner",
			mint,
			recipientOwner: recipient,
			amountMinor: 1000n,
			usdcDecimals: 6,
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "wrong_recipient");
	});

	test("F4: rejects missing Solana Pay reference key", () => {
		const result = evaluateParsedTransfer(
			baseTx({
				transaction: {
					message: { accountKeys: [recipient, mint], instructions: [] },
				},
			}),
			{
				signature: "sig-no-ref",
				mint,
				recipientOwner: recipient,
				amountMinor: 1000n,
				usdcDecimals: 6,
				reference,
			},
		);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "missing_reference");
	});

	test("F4: rejects transaction older than intent", () => {
		const result = evaluateParsedTransfer(baseTx({ blockTime: 1_700_000_000 }), {
			signature: "sig-stale",
			mint,
			recipientOwner: recipient,
			amountMinor: 1000n,
			usdcDecimals: 6,
			reference,
			notBeforeUnix: 1_700_000_050,
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "stale_transaction");
	});
});

describe("isSolanaAddress", () => {
	test("accepts curve pubkeys and rejects garbage", () => {
		assert.equal(isSolanaAddress(recipient), true);
		assert.equal(isSolanaAddress("not-an-address"), false);
		assert.equal(
			isSolanaAddress("GDEMOTESTNETADDRESSONLY000000000000000000000000000000000000"),
			false,
		);
	});
});

describe("evaluateParsedTransfer payer", () => {
	const sender = Keypair.generate().publicKey.toBase58();
	const withSender = (preSender: string, postSender: string) =>
		baseTx({
			meta: {
				err: null,
				preTokenBalances: [
					{ accountIndex: 0, mint, owner: recipient, uiTokenAmount: { amount: "100", decimals: 6 } },
					{ accountIndex: 1, mint, owner: sender, uiTokenAmount: { amount: preSender, decimals: 6 } },
				],
				postTokenBalances: [
					{ accountIndex: 0, mint, owner: recipient, uiTokenAmount: { amount: "1100", decimals: 6 } },
					{ accountIndex: 1, mint, owner: sender, uiTokenAmount: { amount: postSender, decimals: 6 } },
				],
			},
		});

	test("reports the wallet whose balance fell as the payer", () => {
		const result = evaluateParsedTransfer(withSender("5000", "4000"), {
			signature: "sig-payer",
			mint,
			recipientOwner: recipient,
			amountMinor: 1000n,
			usdcDecimals: 6,
			reference,
		} as never);
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.payer, sender);
	});

	test("payer is null when no other balance fell", () => {
		const result = evaluateParsedTransfer(baseTx(), {
			signature: "sig-nopayer",
			mint,
			recipientOwner: recipient,
			amountMinor: 1000n,
			usdcDecimals: 6,
			reference,
		} as never);
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.payer, null);
	});
});
