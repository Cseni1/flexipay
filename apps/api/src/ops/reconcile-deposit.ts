import type { Money, SettlementAdapter } from "@flexipay/domain";
import type { Db } from "../db.ts";
import { newId } from "../ids.ts";
import { persistConfirmedFundDeposit } from "../orchestrator/run.ts";

/**
 * CCR-23 operator-only reconcile: bind a verified deposit identity to a settle leg
 * via lock + compare-and-swap + audit. No secrets are logged.
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
	/** Expected deposited amount (settle fund requirement). */
	amount: Money;
	payer: string;
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
	const confirmed = await settlement.verifyFundDeposit({
		txRef: input.fundTxRef,
		payer: input.payer,
		amount: input.amount,
	});

	return db.$transaction(async (tx) => {
		const payment = await tx.payment.findUnique({
			where: { id: input.paymentId },
			include: { legs: { where: { kind: "settle" }, take: 1 } },
		});
		if (!payment) {
			throw new ReconcileDepositError("not_found", "payment not found");
		}
		const settle = payment.legs[0];
		if (!settle) {
			throw new ReconcileDepositError("no_settle", "payment has no settle leg");
		}

		// Row lock so concurrent reconciles serialize (Postgres).
		await tx.$queryRaw`SELECT id FROM "Leg" WHERE id = ${settle.id} FOR UPDATE`;

		const other = await tx.leg.findFirst({
			where: {
				fundTxRef: confirmed.fundTxRef,
				fundNetwork: confirmed.fundNetwork,
				fundVaultId: confirmed.fundVaultId,
				fundOpIndex: confirmed.fundOpIndex,
				NOT: { id: settle.id },
			},
		});
		if (other) {
			throw new ReconcileDepositError(
				"deposit_already_bound",
				"deposit identity already bound to another settle leg",
			);
		}

		const outcome = await persistConfirmedFundDeposit(tx as unknown as Db, settle.id, confirmed);
		await tx.auditRow.create({
			data: {
				id: newId("aud"),
				paymentId: payment.id,
				entity: "leg",
				entityId: settle.id,
				fromStatus: settle.fundTxRef ? "fund_bound" : "fund_unbound",
				toStatus: "fund_bound",
				reason: `reconcile_deposit:${confirmed.fundTxRef}`,
			},
		});
		await tx.event.create({
			data: {
				id: newId("evt"),
				organizationId: payment.organizationId,
				type: "payment.onchain",
				paymentId: payment.id,
				snapshot: {
					phase: "fund_reconcile",
					fundTxRef: confirmed.fundTxRef,
					fundOpIndex: confirmed.fundOpIndex,
					legId: settle.id,
					outcome,
				},
			},
		});
		return {
			paymentId: payment.id,
			legId: settle.id,
			fundTxRef: confirmed.fundTxRef,
			fundOpIndex: confirmed.fundOpIndex,
			outcome,
		};
	});
}
