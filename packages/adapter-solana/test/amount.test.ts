import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	AMOUNT_NOT_REPRESENTABLE_CODE,
	AmountNotRepresentableError,
	flexipayUsdcToSolanaMinor,
} from "../src/amount.ts";

describe("flexipayUsdcToSolanaMinor", () => {
	test("passes through when Solana decimals match FlexiPay (7)", () => {
		assert.equal(flexipayUsdcToSolanaMinor(9851485n, 7), 9851485n);
	});

	test("converts exact 6-decimal amounts (9950000 → 995000)", () => {
		assert.equal(flexipayUsdcToSolanaMinor(9950000n, 6), 995000n);
	});

	test("rejects unrepresentable 7→6 amounts with stable error code", () => {
		assert.throws(
			() => flexipayUsdcToSolanaMinor(9851485n, 6),
			(err: unknown) => {
				assert.ok(err instanceof AmountNotRepresentableError);
				assert.equal(err.code, AMOUNT_NOT_REPRESENTABLE_CODE);
				assert.match(err.message, /not representable/i);
				return true;
			},
		);
	});

	test("accepts floored quote example 9851480 at 6 decimals", () => {
		assert.equal(flexipayUsdcToSolanaMinor(9851480n, 6), 985148n);
	});

	test("scales up for mints with more than 7 decimals", () => {
		assert.equal(flexipayUsdcToSolanaMinor(12n, 9), 1200n);
	});

	test("scales down to 2 decimals (tGBP-style) when exact", () => {
		assert.equal(flexipayUsdcToSolanaMinor(10_500_000n, 2), 105n);
		assert.throws(() => flexipayUsdcToSolanaMinor(10_500_001n, 2), AmountNotRepresentableError);
	});

	test("rejects decimals outside 0–9", () => {
		assert.throws(() => flexipayUsdcToSolanaMinor(1n, 10), /invalid Solana USDC decimals/);
		assert.throws(() => flexipayUsdcToSolanaMinor(1n, -1), /invalid Solana USDC decimals/);
	});
});
