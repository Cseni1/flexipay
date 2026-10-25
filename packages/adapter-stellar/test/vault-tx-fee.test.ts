import { describe, expect, it } from "vitest";
import {
	SOROBAN_TX_FEE_CEILING_ENV,
	SOROBAN_TX_FEE_UINT32_MAX,
	VaultTxFeeError,
	breakdownAssembledFee,
	legacySignPathDoubleCountTotal,
	parseSorobanTxFeeCeiling,
	validateSorobanTxFee,
} from "../src/vault-tx-fee.ts";
import { loadStellarEnv, parseEnvFile } from "../src/stellar-env.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoFile = (path: string) =>
	readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");

describe("legacySignPathDoubleCountTotal vs single-count", () => {
	it("shows historical overflow resource fee: old path overflows uint32, corrected fits", () => {
		// Diagnosis evidence: minResourceFee 2820986533, assembled builtFee 2820986633
		const resourceFee = 2_820_986_533n;
		const assembledTotal = 2_820_986_633n; // inclusion 100 + resource
		const parts = breakdownAssembledFee(assembledTotal, resourceFee);
		expect(parts.inclusionFee).toBe(100n);
		expect(parts.totalOnce).toBe(assembledTotal);
		expect(parts.totalOnce <= SOROBAN_TX_FEE_UINT32_MAX).toBe(true);

		const legacy = legacySignPathDoubleCountTotal(assembledTotal, resourceFee);
		expect(legacy).toBe(assembledTotal + resourceFee);
		expect(legacy).toBe(5_641_973_166n);
		expect(legacy > SOROBAN_TX_FEE_UINT32_MAX).toBe(true);
	});

	it("rejects double-counted total in validateSorobanTxFee", () => {
		const resourceFee = 2_820_986_533n;
		const assembledTotal = 2_820_986_633n;
		const legacy = legacySignPathDoubleCountTotal(assembledTotal, resourceFee);
		expect(() =>
			validateSorobanTxFee({
				totalFee: legacy,
				resourceFee,
				assembledTotalFee: assembledTotal,
				ceilingStroops: SOROBAN_TX_FEE_UINT32_MAX,
			}),
		).toThrow(VaultTxFeeError);
		try {
			validateSorobanTxFee({
				totalFee: legacy,
				resourceFee,
				assembledTotalFee: assembledTotal,
				ceilingStroops: SOROBAN_TX_FEE_UINT32_MAX,
			});
		} catch (e) {
			expect(e).toBeInstanceOf(VaultTxFeeError);
			expect((e as VaultTxFeeError).reason).toBe("double_counted_resource_fee");
		}
	});

	it("accepts single-count total under ceiling", () => {
		const resourceFee = 692_289n;
		const assembledTotal = 692_389n;
		const parts = validateSorobanTxFee({
			totalFee: assembledTotal,
			resourceFee,
			assembledTotalFee: assembledTotal,
			ceilingStroops: 2_000_000n,
		});
		expect(parts.totalOnce).toBe(assembledTotal);
		expect(parts.inclusionFee).toBe(100n);
	});

	it("fails typed when ceiling is not configured (never invents a default)", () => {
		expect(() =>
			validateSorobanTxFee({
				totalFee: 1_000n,
				resourceFee: 900n,
				assembledTotalFee: 1_000n,
				ceilingStroops: null,
			}),
		).toThrow(/FP_SOROBAN_TX_FEE_CEILING_STROOPS/);
		try {
			validateSorobanTxFee({
				totalFee: 1_000n,
				resourceFee: 900n,
				assembledTotalFee: 1_000n,
				ceilingStroops: null,
			});
		} catch (e) {
			expect((e as VaultTxFeeError).reason).toBe("ceiling_not_configured");
		}
	});

	it("fails typed when total exceeds configured ceiling without capping", () => {
		try {
			validateSorobanTxFee({
				totalFee: 500_000n,
				resourceFee: 499_900n,
				assembledTotalFee: 500_000n,
				ceilingStroops: 100_000n,
			});
			expect.unreachable("should throw");
		} catch (e) {
			expect(e).toBeInstanceOf(VaultTxFeeError);
			expect((e as VaultTxFeeError).reason).toBe("fee_exceeds_ceiling");
			expect((e as VaultTxFeeError).totalFee).toBe(500_000n);
			expect((e as VaultTxFeeError).ceiling).toBe(100_000n);
		}
	});
});

describe("parseSorobanTxFeeCeiling / loadStellarEnv", () => {
	it("returns null when unset", () => {
		expect(parseSorobanTxFeeCeiling({})).toBeNull();
		expect(parseSorobanTxFeeCeiling({ [SOROBAN_TX_FEE_CEILING_ENV]: "" })).toBeNull();
	});

	it("parses a confirmed integer stroop ceiling", () => {
		expect(parseSorobanTxFeeCeiling({ [SOROBAN_TX_FEE_CEILING_ENV]: "4294967295" })).toBe(
			SOROBAN_TX_FEE_UINT32_MAX,
		);
	});

	it("loads ceiling as null from published testnet ids until Claude sets a default", () => {
		const ids = parseEnvFile(repoFile("scripts/testnet/testnet-ids.env"));
		const env = loadStellarEnv(ids);
		expect(env.sorobanTxFeeCeilingStroops).toBeNull();
	});
});
