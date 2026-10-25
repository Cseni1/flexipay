#!/usr/bin/env node
/**
 * CCR-23 operator-only local CLI: bind a verified vault deposit to a payment settle leg.
 *
 * Usage (disposable / local DB only — never against stranded shared DBs without backup review):
 *   FP_SETTLEMENT=mock DATABASE_URL=postgres://... npx tsx scripts/ops/reconcile-deposit.ts \
 *     --payment-id pay_... \
 *     --fund-tx-ref <hash>
 *
 * Optional cross-checks (must match payment-derived amount / configured vault payer):
 *     --amount <minor> --currency USDC --payer <G...>
 *
 * Authoritative expectations:
 *   - amount ← payment settleFundAmount (quote feeMode + flexiPayFee)
 *   - payer  ← FP_PAYER_DEMO_ADDRESS (same as API vault payer)
 *
 * DATABASE_URL and FP_SETTLEMENT are required from the environment (no code defaults;
 * no --database-url). Does not log DB URLs, credentials, or secrets.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../../apps/api/src/db.ts";
import {
	argFrom,
	validateReconcileCliInvocation,
} from "../../apps/api/src/ops/reconcile-deposit-cli.ts";
import { reconcileDepositToPayment } from "../../apps/api/src/ops/reconcile-deposit.ts";
import { createSettlement } from "../../apps/api/src/settlement.ts";

async function main(): Promise<void> {
	const validated = validateReconcileCliInvocation({
		argv: process.argv,
		env: process.env,
	});
	if (!validated.ok) {
		console.error(validated.message);
		process.exit(validated.exitCode);
	}

	const payerCrossCheck = argFrom(process.argv, "payer")?.trim();
	const amountValue = argFrom(process.argv, "amount")?.trim();
	const currency = (argFrom(process.argv, "currency") ?? "USDC").trim();

	const vaultPayer =
		process.env.FP_PAYER_DEMO_ADDRESS?.trim() ||
		"GDEMOPAYER000000000000000000000000000000000000000000";

	const db = createDb(validated.databaseUrl);
	try {
		const { adapter } = await createSettlement({ env: process.env });
		const result = await reconcileDepositToPayment(db, adapter, {
			paymentId: validated.paymentId,
			fundTxRef: validated.fundTxRef,
			vaultPayer,
			payerCrossCheck,
			amountCrossCheck:
				amountValue !== undefined
					? { amount: amountValue, currency }
					: undefined,
		});
		// Minimal success line — no secret / DB URL fields.
		console.log(
			JSON.stringify({
				ok: true,
				paymentId: result.paymentId,
				legId: result.legId,
				fundTxRef: result.fundTxRef,
				fundOpIndex: result.fundOpIndex,
				outcome: result.outcome,
			}),
		);
	} catch (e) {
		const code =
			e && typeof e === "object" && "code" in e
				? String((e as { code: unknown }).code)
				: "failed";
		const message = e instanceof Error ? e.message : String(e);
		console.error(JSON.stringify({ ok: false, code, message }));
		process.exit(1);
	} finally {
		await db.$disconnect();
	}
}

const scriptPath = resolve(fileURLToPath(import.meta.url));
const isMain = process.argv.some((entry) => {
	try {
		return resolve(entry) === scriptPath;
	} catch {
		return false;
	}
});

if (isMain) {
	void main();
}
