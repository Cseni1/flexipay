import {
	TransactionBuilder,
	type Transaction,
	xdr,
} from "@stellar/stellar-sdk";
import { contract } from "@stellar/stellar-sdk";

/** Stellar Transaction.fee / resourceFee are uint32 on the wire. */
export const SOROBAN_TX_FEE_UINT32_MAX = 4_294_967_295n;

/**
 * Env name for the max allowed total Soroban tx fee (inclusion + resource, once), in stroops.
 * Default value is intentionally unset until Claude confirms it — do not invent one in code.
 */
export const SOROBAN_TX_FEE_CEILING_ENV = "FP_SOROBAN_TX_FEE_CEILING_STROOPS";

export type VaultTxFeeRejectReason =
	| "missing_built"
	| "missing_simulation_data"
	| "resource_fee_mismatch"
	| "double_counted_resource_fee"
	| "fee_exceeds_uint32"
	| "ceiling_not_configured"
	| "fee_exceeds_ceiling"
	| "negative_or_invalid_fee";

export class VaultTxFeeError extends Error {
	readonly reason: VaultTxFeeRejectReason;
	readonly inclusionFee?: bigint;
	readonly resourceFee?: bigint;
	readonly totalFee?: bigint;
	readonly ceiling?: bigint | null;

	constructor(
		reason: VaultTxFeeRejectReason,
		message: string,
		details: {
			inclusionFee?: bigint;
			resourceFee?: bigint;
			totalFee?: bigint;
			ceiling?: bigint | null;
		} = {},
	) {
		super(message);
		this.name = "VaultTxFeeError";
		this.reason = reason;
		this.inclusionFee = details.inclusionFee;
		this.resourceFee = details.resourceFee;
		this.totalFee = details.totalFee;
		this.ceiling = details.ceiling;
	}
}

export interface SorobanFeeBreakdown {
	inclusionFee: bigint;
	resourceFee: bigint;
	/** inclusion + resource exactly once (= AssembledTransaction.built.fee after simulate). */
	totalOnce: bigint;
}

/** Legacy AssembledTransaction.sign() path: passes fee: built.fee into cloneFrom, then build() adds resourceFee again. */
export function legacySignPathDoubleCountTotal(assembledTotalFee: bigint, resourceFee: bigint): bigint {
	return assembledTotalFee + resourceFee;
}

export function breakdownAssembledFee(
	assembledTotalFee: bigint,
	resourceFee: bigint,
): SorobanFeeBreakdown {
	if (assembledTotalFee < 0n || resourceFee < 0n) {
		throw new VaultTxFeeError("negative_or_invalid_fee", "fee components must be non-negative", {
			totalFee: assembledTotalFee,
			resourceFee,
		});
	}
	if (assembledTotalFee < resourceFee) {
		throw new VaultTxFeeError(
			"resource_fee_mismatch",
			`assembled total fee ${assembledTotalFee} is less than resourceFee ${resourceFee}`,
			{ totalFee: assembledTotalFee, resourceFee },
		);
	}
	const inclusionFee = assembledTotalFee - resourceFee;
	return {
		inclusionFee,
		resourceFee,
		totalOnce: inclusionFee + resourceFee,
	};
}

/**
 * Claude's reviewed build-once rebuild: cloneFrom without a fee override so inclusion is
 * stripped correctly and resourceFee is applied exactly once in build().
 */
export function rebuildSorobanTxFeeOnce(
	built: Transaction,
	sorobanData: xdr.SorobanTransactionData,
	timeoutInSeconds: number = contract.DEFAULT_TIMEOUT,
): Transaction {
	return TransactionBuilder.cloneFrom(built, {
		timebounds: undefined,
		sorobanData,
	})
		.setTimeout(timeoutInSeconds)
		.build();
}

/** What AssembledTransaction.sign() does today (fee: built.fee override) — for regressions only. */
export function rebuildSorobanTxFeeLegacyDoubleCount(
	built: Transaction,
	sorobanData: xdr.SorobanTransactionData,
	timeoutInSeconds: number = contract.DEFAULT_TIMEOUT,
): Transaction {
	return TransactionBuilder.cloneFrom(built, {
		fee: built.fee,
		timebounds: undefined,
		sorobanData,
	})
		.setTimeout(timeoutInSeconds)
		.build();
}

export function validateSorobanTxFee(input: {
	totalFee: bigint;
	resourceFee: bigint;
	/** Expected assembled total (inclusion+resource once) before any sign()-path rebuild. */
	assembledTotalFee: bigint;
	ceilingStroops: bigint | null | undefined;
}): SorobanFeeBreakdown {
	const parts = breakdownAssembledFee(input.assembledTotalFee, input.resourceFee);

	if (input.totalFee !== parts.totalOnce) {
		const legacy = legacySignPathDoubleCountTotal(input.assembledTotalFee, input.resourceFee);
		throw new VaultTxFeeError(
			input.totalFee === legacy ? "double_counted_resource_fee" : "resource_fee_mismatch",
			input.totalFee === legacy
				? `tx fee ${input.totalFee} double-counts resourceFee (assembled ${input.assembledTotalFee} + resource ${input.resourceFee})`
				: `tx fee ${input.totalFee} != inclusion ${parts.inclusionFee} + resource ${parts.resourceFee}`,
			{
				inclusionFee: parts.inclusionFee,
				resourceFee: parts.resourceFee,
				totalFee: input.totalFee,
				ceiling: input.ceilingStroops ?? null,
			},
		);
	}

	if (parts.totalOnce > SOROBAN_TX_FEE_UINT32_MAX) {
		throw new VaultTxFeeError(
			"fee_exceeds_uint32",
			`total fee ${parts.totalOnce} exceeds uint32 max ${SOROBAN_TX_FEE_UINT32_MAX}`,
			{
				inclusionFee: parts.inclusionFee,
				resourceFee: parts.resourceFee,
				totalFee: parts.totalOnce,
				ceiling: input.ceilingStroops ?? null,
			},
		);
	}

	if (input.ceilingStroops == null) {
		throw new VaultTxFeeError(
			"ceiling_not_configured",
			`${SOROBAN_TX_FEE_CEILING_ENV} is not set; Claude must confirm the ceiling before vault writes can sign`,
			{
				inclusionFee: parts.inclusionFee,
				resourceFee: parts.resourceFee,
				totalFee: parts.totalOnce,
				ceiling: null,
			},
		);
	}

	if (parts.totalOnce > input.ceilingStroops) {
		throw new VaultTxFeeError(
			"fee_exceeds_ceiling",
			`total fee ${parts.totalOnce} exceeds configured ceiling ${input.ceilingStroops} (${SOROBAN_TX_FEE_CEILING_ENV})`,
			{
				inclusionFee: parts.inclusionFee,
				resourceFee: parts.resourceFee,
				totalFee: parts.totalOnce,
				ceiling: input.ceilingStroops,
			},
		);
	}

	return parts;
}

/**
 * Rebuild assembled simulate output for submit without the SDK sign() double-count,
 * then validate inclusion+resource once, uint32, and ceiling. Never caps or truncates.
 */
export function rebuildAndValidateVaultWriteFee(input: {
	built: Transaction | undefined;
	sorobanData: xdr.SorobanTransactionData | undefined;
	ceilingStroops: bigint | null | undefined;
	timeoutInSeconds?: number;
}): { tx: Transaction; breakdown: SorobanFeeBreakdown } {
	if (!input.built) {
		throw new VaultTxFeeError("missing_built", "AssembledTransaction has no built envelope");
	}
	if (!input.sorobanData) {
		throw new VaultTxFeeError(
			"missing_simulation_data",
			"AssembledTransaction has no simulationData.transactionData",
		);
	}

	const assembledTotalFee = BigInt(input.built.fee);
	const resourceFee = BigInt(input.sorobanData.resourceFee().toString());
	const timeout = input.timeoutInSeconds ?? contract.DEFAULT_TIMEOUT;

	const rebuilt = rebuildSorobanTxFeeOnce(input.built, input.sorobanData, timeout);
	const breakdown = validateSorobanTxFee({
		totalFee: BigInt(rebuilt.fee),
		resourceFee,
		assembledTotalFee,
		ceilingStroops: input.ceilingStroops,
	});

	// Rebuild must preserve the assembled single-count total.
	if (BigInt(rebuilt.fee) !== assembledTotalFee) {
		throw new VaultTxFeeError(
			"resource_fee_mismatch",
			`build-once fee ${rebuilt.fee} != assembled fee ${assembledTotalFee} (Claude cloneFrom proposal discrepancy)`,
			{
				inclusionFee: breakdown.inclusionFee,
				resourceFee,
				totalFee: BigInt(rebuilt.fee),
				ceiling: input.ceilingStroops ?? null,
			},
		);
	}

	return { tx: rebuilt, breakdown };
}

/** Parse ceiling from env map; missing/blank → null (not configured). Never invents a default. */
export function parseSorobanTxFeeCeiling(
	env: Record<string, string | undefined> = process.env,
): bigint | null {
	const raw = env[SOROBAN_TX_FEE_CEILING_ENV]?.trim();
	if (!raw) return null;
	if (!/^[0-9]+$/.test(raw)) {
		throw new Error(
			`${SOROBAN_TX_FEE_CEILING_ENV} must be a non-negative integer (stroops), got ${raw}`,
		);
	}
	const value = BigInt(raw);
	if (value > SOROBAN_TX_FEE_UINT32_MAX) {
		throw new Error(
			`${SOROBAN_TX_FEE_CEILING_ENV} must be <= uint32 max ${SOROBAN_TX_FEE_UINT32_MAX}, got ${raw}`,
		);
	}
	return value;
}
