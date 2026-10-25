#!/usr/bin/env node
/**
 * CCR-23 operator-only local CLI: bind a verified vault deposit to a payment settle leg.
 *
 * Usage (disposable / local DB only — never against stranded shared DBs without backup review):
 *   npx tsx scripts/ops/reconcile-deposit.ts \
 *     --database-url "$DATABASE_URL" \
 *     --payment-id pay_... \
 *     --fund-tx-ref <hash> \
 *     --payer <G...> \
 *     --amount <minor> \
 *     --currency USDC
 *
 * Does not log secrets or sensitive payloads. FP_SETTLEMENT defaults to mock for local fixtures.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../../apps/api/src/db.ts";
import { reconcileDepositToPayment } from "../../apps/api/src/ops/reconcile-deposit.ts";
import { createSettlement } from "../../apps/api/src/settlement.ts";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	if (i < 0) return undefined;
	return process.argv[i + 1];
}

function requireArg(name: string): string {
	const v = arg(name)?.trim();
	if (!v) {
		console.error(`missing --${name}`);
		process.exit(2);
	}
	return v;
}

async function main(): Promise<void> {
	const databaseUrl = requireArg("database-url");
	const paymentId = requireArg("payment-id");
	const fundTxRef = requireArg("fund-tx-ref");
	const payer = requireArg("payer");
	const amountValue = requireArg("amount");
	const currency = (arg("currency") ?? "USDC").trim();

	if (!/^[0-9]+$/.test(amountValue)) {
		console.error("--amount must be an integer minor-unit string");
		process.exit(2);
	}

	process.env.FP_SETTLEMENT = process.env.FP_SETTLEMENT ?? "mock";
	const db = createDb(databaseUrl);
	try {
		const { adapter } = await createSettlement({ env: process.env });
		const result = await reconcileDepositToPayment(db, adapter, {
			paymentId,
			fundTxRef,
			payer,
			amount: { amount: amountValue, currency },
		});
		// Minimal success line — no secret fields.
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

const isMain =
	process.argv[1] &&
	resolve(process.argv[1]) ===
		resolve(fileURLToPath(import.meta.url));

if (isMain) {
	void main();
}
