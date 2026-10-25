import { describe, expect, it } from "vitest";
import { FundDepositVerifyError } from "@flexipay/domain";
import {
	listVaultDepositInvokes,
	matchSingleVaultDeposit,
} from "../src/vault-deposit-decode.ts";
import { FeeBumpTransaction, TransactionBuilder } from "@stellar/stellar-sdk";

describe("CCR-23 vault deposit decode matching", () => {
	const vaultId = "C" + "A".repeat(55);
	const payer = "G" + "B".repeat(55);

	it("accepts exactly one matching deposit and returns its decoded opIndex", () => {
		const hit = matchSingleVaultDeposit({
			invokes: [
				{ opIndex: 2, contractId: vaultId, payer, amount: 101n },
				{ opIndex: 0, contractId: "C" + "Z".repeat(55), payer, amount: 101n },
			],
			vaultId,
			payer,
			amountMinor: 101n,
		});
		expect(hit.opIndex).toBe(2);
	});

	it("rejects zero matches", () => {
		expect(() =>
			matchSingleVaultDeposit({
				invokes: [{ opIndex: 0, contractId: vaultId, payer, amount: 1n }],
				vaultId,
				payer,
				amountMinor: 101n,
			}),
		).toThrow(FundDepositVerifyError);
		try {
			matchSingleVaultDeposit({
				invokes: [],
				vaultId,
				payer,
				amountMinor: 101n,
			});
		} catch (e) {
			expect((e as FundDepositVerifyError).code).toBe("not_found");
		}
	});

	it("rejects multiple matching deposits (no assumed index 0)", () => {
		expect(() =>
			matchSingleVaultDeposit({
				invokes: [
					{ opIndex: 0, contractId: vaultId, payer, amount: 101n },
					{ opIndex: 3, contractId: vaultId, payer, amount: 101n },
				],
				vaultId,
				payer,
				amountMinor: 101n,
			}),
		).toThrow(FundDepositVerifyError);
		try {
			matchSingleVaultDeposit({
				invokes: [
					{ opIndex: 0, contractId: vaultId, payer, amount: 101n },
					{ opIndex: 3, contractId: vaultId, payer, amount: 101n },
				],
				vaultId,
				payer,
				amountMinor: 101n,
			});
		} catch (e) {
			expect((e as FundDepositVerifyError).code).toBe("ambiguous");
		}
	});

	it("rejects fee-bump / wrapper envelopes without unwrapping inner deposits", () => {
		// Minimal stub: if fromXDR yields a FeeBumpTransaction, listVaultDepositInvokes must reject.
		const passphrase = "Test SDF Network ; September 2015";
		const original = TransactionBuilder.fromXDR.bind(TransactionBuilder);
		const fakeBump = Object.create(FeeBumpTransaction.prototype) as FeeBumpTransaction;
		TransactionBuilder.fromXDR = (() => fakeBump) as typeof TransactionBuilder.fromXDR;
		try {
			expect(() => listVaultDepositInvokes("AAAA", passphrase)).toThrow(
				FundDepositVerifyError,
			);
			try {
				listVaultDepositInvokes("AAAA", passphrase);
			} catch (e) {
				expect((e as FundDepositVerifyError).code).toBe("not_found");
				expect((e as Error).message).toMatch(/wrapper|fee-bump/i);
			}
		} finally {
			TransactionBuilder.fromXDR = original;
		}
	});
});
