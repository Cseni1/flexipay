import type { FeeMode, Money, SettlementAdapter } from "@flexipay/domain";
import type { Db } from "../db.ts";
import { newId } from "../ids.ts";
import {
	isFundDepositConfirmed,
	persistConfirmedFundDeposit,
	settleFundAmount,
} from "../orchestrator/run.ts";

/**
 * CCR-23 operator-only reconcile: bind a verified deposit identity to a settle leg
 * via DB-transaction row lock + compare-and-swap + audit. No secrets are logged.
 *
 * Expected amount comes from the payment settle fund requirement; expected payer
 * from the configured vault payer. Optional CLI amount/payer are cross-checks only.
 */

export class ReconcileDepositError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "ReconcileDepositError";
		this.code = code;
	}
}

export interface ReconcileDepositInput {
	paymentId: string;
	fundTxRef: string;
	/** Configured vault payer (authoritative). */
	vaultPayer: string;
	/** Optional cross-check — must equal payment-derived settle fund amount. */
	amountCrossCheck?: Money;
	/** Optional cross-check — must equal vaultPayer. */
	payerCrossCheck?: string;
}

export interface ReconcileDepositResult {
	paymentId: string;
	legId: string;
	fundTxRef: string;
	fundOpIndex: number;
	outcome: "written" | "already_same";
}

export async function reconcileDepositToPayment(
	db: Db,
	settlement: SettlementAdapter,
	input: ReconcileDepositInput,
): Promise<ReconcileDepositResult> {
	const payment = await db.payment.findUnique({
		where: { id: input.paymentId },
		include: {
			legs: { where: { kind: "settle" }, take: 1 },
			quote: true,
		},
	});
	if (!payment) {
		throw new ReconcileDepositError("not_found", "payment not found");
	}
	const settle = payment.legs[0];
	if (!settle) {
		throw new ReconcileDepositError("no_settle", "payment has no settle leg");
	}

	const feeMode = payment.quote.feeMode as FeeMode | null;
	if (!feeMode) {
		throw new ReconcileDepositError(
			"missing_fee_mode",
			"quote.feeMode missing for settle fund expectation (CCR-13)",
		);
	}
	const fees = payment.quote.fees as {
		flexiPayFee?: { amount?: string; currency?: string };
	} | null;
	const quoted = fees?.flexiPayFee;
	if (!quoted?.amount || !quoted.currency) {
		throw new ReconcileDepositError(
			"missing_quoted_fee",
			"quote.fees.flexiPayFee missing for settle fund expectation (CCR-13)",
		);
	}
	const expectedAmount = settleFundAmount(
		settle,
		{ amount: quoted.amount, currency: quoted.currency },
		feeMode,
	);
	const expectedPayer = input.vaultPayer;

	if (input.amountCrossCheck) {
		if (
			input.amountCrossCheck.amount !== expectedAmount.amount ||
			input.amountCrossCheck.currency !== expectedAmount.currency
		) {
			throw new ReconcileDepositError(
				"amount_mismatch",
				"CLI amount cross-check does not match payment settle fund requirement",
			);
		}
	}
	if (
		input.payerCrossCheck !== undefined &&
		input.payerCrossCheck !== expectedPayer
	) {
		throw new ReconcileDepositError(
			"payer_mismatch",
			"CLI payer cross-check does not match configured vault payer",
		);
	}

	const confirmed = await settlement.verifyFundDeposit({
		txRef: input.fundTxRef,
		payer: expectedPayer,
		amount: expectedAmount,
	});

	return db.$transaction(async (tx) => {
		const lockedPayment = await tx.payment.findUnique({
			where: { id: input.paymentId },
			include: { legs: { where: { kind: "settle" }, take: 1 } },
		});
		if (!lockedPayment) {
			throw new ReconcileDepositError("not_found", "payment not found");
		}
		const lockedSettle = lockedPayment.legs[0];
		if (!lockedSettle) {
			throw new ReconcileDepositError("no_settle", "payment has no settle leg");
		}

		// Row lock so concurrent reconciles serialize (Postgres).
		await tx.$queryRaw`SELECT id FROM "Leg" WHERE id = ${lockedSettle.id} FOR UPDATE`;

		if (
			lockedSettle.fundTxRef &&
			lockedSettle.fundTxRef !== confirmed.fundTxRef
		) {
			throw new ReconcileDepositError(
				"different_fund_tx",
				"settle leg already has a different fundTxRef",
			);
		}

		// App-level: same fundTxRef on another leg (partial unique allows null opIndex).
		const sameHashOther = await tx.leg.findFirst({
			where: {
				fundTxRef: confirmed.fundTxRef,
				NOT: { id: lockedSettle.id },
			},
		});
		if (sameHashOther) {
			throw new ReconcileDepositError(
				"deposit_already_bound",
				"deposit fundTxRef already present on another settle leg",
			);
		}

		const otherBound = await tx.leg.findFirst({
			where: {
				fundTxRef: confirmed.fundTxRef,
				fundNetwork: confirmed.fundNetwork,
				fundVaultId: confirmed.fundVaultId,
				fundOpIndex: confirmed.fundOpIndex,
				NOT: { id: lockedSettle.id },
			},
		});
		if (otherBound) {
			throw new ReconcileDepositError(
				"deposit_already_bound",
				"deposit identity already bound to another settle leg",
			);
		}

		const fromStatus = isFundDepositConfirmed(lockedSettle)
			? "fund_bound"
			: lockedSettle.fundTxRef
				? "fund_pending"
				: "fund_unbound";

		const outcome = await persistConfirmedFundDeposit(
			tx as unknown as Db,
			lockedSettle.id,
			confirmed,
		);
		await tx.auditRow.create({
			data: {
				id: newId("aud"),
				paymentId: lockedPayment.id,
				entity: "leg",
				entityId: lockedSettle.id,
				fromStatus,
				toStatus: "fund_bound",
				reason: `reconcile_deposit:${confirmed.fundTxRef}`,
			},
		});
		await tx.event.create({
			data: {
				id: newId("evt"),
				organizationId: lockedPayment.organizationId,
				type: "payment.onchain",
				paymentId: lockedPayment.id,
				snapshot: {
					phase: "fund_reconcile",
					fundTxRef: confirmed.fundTxRef,
					fundOpIndex: confirmed.fundOpIndex,
					legId: lockedSettle.id,
					outcome,
				},
			},
		});
		return {
			paymentId: lockedPayment.id,
			legId: lockedSettle.id,
			fundTxRef: confirmed.fundTxRef,
			fundOpIndex: confirmed.fundOpIndex,
			outcome,
		};
	});
}
