import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { Keypair } from "@solana/web3.js";
import { evaluateParsedTransfer } from "../src/verify-transfer.ts";
import { isSolanaAddress } from "../src/address.ts";

const mint = Keypair.generate().publicKey.toBase58();
const recipient = Keypair.generate().publicKey.toBase58();
const other = Keypair.generate().publicKey.toBase58();

const baseTx = (overrides: Record<string, unknown> = {}) =>
	({
		slot: 42,
		transaction: {
			message: {
				accountKeys: [recipient, mint],
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
		});
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.amountMinor, 1000n);
	});

	test("rejects failed on-chain meta", () => {
		const result = evaluateParsedTransfer(
			baseTx({ meta: { err: { InstructionError: [0, "Custom"] }, preTokenBalances: [], postTokenBalances: [] } }),
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
});

describe("isSolanaAddress", () => {
	test("accepts curve pubkeys and rejects garbage", () => {
		assert.equal(isSolanaAddress(recipient), true);
		assert.equal(isSolanaAddress("not-an-address"), false);
		assert.equal(isSolanaAddress("GDEMOTESTNETADDRESSONLY000000000000000000000000000000000000"), false);
	});
});
