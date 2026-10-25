import { Account, Keypair, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import {
	buildAndSignClassicPaymentWithMemo,
	submitClassicPaymentWithMemo,
	submitSignedClassicPayment,
	type ClassicPaymentHorizon,
} from "../src/anchor-classic-payment.ts";
import { parseClassicAssetLine } from "../src/anchor-asset.ts";
import type { AnchorPaymentExpectation } from "../src/anchor-client.ts";
import { AnchorClientError } from "../src/anchor-client.ts";

const NET = "Test SDF Network ; September 2015";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const asset = parseClassicAssetLine(`USDC:${ISSUER}`, NET);

const destination = Keypair.random().publicKey();
const source = Keypair.random();

function expectation(): AnchorPaymentExpectation {
	return {
		destination,
		memo: "df7-memo-1",
		memoType: "text",
		amount: "1.0000000",
		asset,
	};
}

function fakeHorizon(sequence: string): ClassicPaymentHorizon & {
	submitTransaction: ReturnType<typeof vi.fn>;
	loadAccount: ReturnType<typeof vi.fn>;
} {
	const submitTransaction = vi.fn(async (tx: Transaction) => ({
		hash: Buffer.from(tx.hash()).toString("hex"),
	}));
	const loadAccount = vi.fn(
		async () => new Account(source.publicKey(), sequence),
	);
	return {
		loadAccount,
		fetchBaseFee: vi.fn(async () => 100),
		submitTransaction,
	};
}

describe("classic payment build / submit split", () => {
	it("exposes a finite hash and time bounds before any submit", async () => {
		const horizon = fakeHorizon("42");

		const built = await buildAndSignClassicPaymentWithMemo({
			networkPassphrase: NET,
			source,
			expectation: expectation(),
			timeoutSeconds: 45,
			horizon,
		});

		expect(horizon.submitTransaction).not.toHaveBeenCalled();
		expect(built.txHash).toMatch(/^[0-9a-f]{64}$/);
		expect(built.txHash).toBe(
			Buffer.from(built.signedTx.hash()).toString("hex"),
		);
		expect(Number.isFinite(built.timeBounds.minTime)).toBe(true);
		expect(Number.isFinite(built.timeBounds.maxTime)).toBe(true);
		expect(built.timeBounds.maxTime - built.timeBounds.minTime).toBe(45);
		expect(built.memoPresent).toBe(true);
		expect(built.destination).toBe(destination);
		expect(built.amount).toBe("1.0000000");
	});

	it("submits the identical signed transaction (same hash)", async () => {
		const horizon = fakeHorizon("43");

		const built = await buildAndSignClassicPaymentWithMemo({
			networkPassphrase: NET,
			source,
			expectation: expectation(),
			horizon,
		});
		const preHash = built.txHash;

		const result = await submitSignedClassicPayment({
			signedTx: built.signedTx,
			expectedTxHash: preHash,
			destination: built.destination,
			amount: built.amount,
			asset: built.asset,
			horizon,
		});

		expect(horizon.submitTransaction).toHaveBeenCalledTimes(1);
		const submitted = horizon.submitTransaction.mock
			.calls[0]![0] as Transaction;
		expect(Buffer.from(submitted.hash()).toString("hex")).toBe(preHash);
		expect(submitted).toBe(built.signedTx);
		expect(result.txHash).toBe(preHash);
	});

	it("wrapper remains compatible: one-shot build+submit", async () => {
		const horizon = fakeHorizon("44");

		const result = await submitClassicPaymentWithMemo({
			networkPassphrase: NET,
			source,
			expectation: expectation(),
			horizon,
		});

		expect(horizon.loadAccount).toHaveBeenCalled();
		expect(horizon.submitTransaction).toHaveBeenCalledTimes(1);
		expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
		expect(result.destination).toBe(destination);
		expect(result.amount).toBe("1.0000000");
		expect(result.memoPresent).toBe(true);
	});

	it("preserves asset / amount / destination / memo validation", async () => {
		const horizon = fakeHorizon("46");
		await expect(
			buildAndSignClassicPaymentWithMemo({
				networkPassphrase: NET,
				source,
				expectation: {
					destination: "",
					memo: "x",
					amount: "1",
					asset,
				},
				horizon,
			}),
		).rejects.toBeInstanceOf(AnchorClientError);

		await expect(
			buildAndSignClassicPaymentWithMemo({
				networkPassphrase: "Other Network",
				source,
				expectation: expectation(),
				horizon,
			}),
		).rejects.toMatchObject({ code: "network_mismatch" });
		expect(horizon.loadAccount).not.toHaveBeenCalled();
	});

	it("rejects submit when expectedTxHash does not match signed bytes", async () => {
		const horizon = fakeHorizon("45");

		const built = await buildAndSignClassicPaymentWithMemo({
			networkPassphrase: NET,
			source,
			expectation: expectation(),
			horizon,
		});

		await expect(
			submitSignedClassicPayment({
				signedTx: built.signedTx,
				expectedTxHash: "0".repeat(64),
				destination: built.destination,
				amount: built.amount,
				asset: built.asset,
				horizon,
			}),
		).rejects.toMatchObject({ code: "classic_payment_failed" });
		expect(horizon.submitTransaction).not.toHaveBeenCalled();
	});
});
