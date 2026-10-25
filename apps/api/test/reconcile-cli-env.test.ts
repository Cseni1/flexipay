import { describe, expect, it } from "vitest";
import { validateReconcileCliInvocation } from "../src/ops/reconcile-deposit-cli.ts";

describe("reconcile-deposit CLI env", () => {
	it("rejects --database-url; requires DATABASE_URL and FP_SETTLEMENT", () => {
		const withArg = validateReconcileCliInvocation({
			argv: [
				"node",
				"reconcile-deposit.ts",
				"--database-url",
				"postgres://should-not-appear",
				"--payment-id",
				"pay_x",
				"--fund-tx-ref",
				"tx",
			],
			env: { FP_SETTLEMENT: "mock" },
		});
		expect(withArg.ok).toBe(false);
		if (!withArg.ok) {
			expect(withArg.exitCode).toBe(2);
			expect(withArg.message).toMatch(/--database-url is not accepted/);
			expect(withArg.message).not.toMatch(/postgres:\/\/should-not-appear/);
		}

		const noDb = validateReconcileCliInvocation({
			argv: ["node", "reconcile-deposit.ts", "--payment-id", "pay_x", "--fund-tx-ref", "tx"],
			env: { FP_SETTLEMENT: "mock", DATABASE_URL: "" },
		});
		expect(noDb.ok).toBe(false);
		if (!noDb.ok) {
			expect(noDb.exitCode).toBe(2);
			expect(noDb.message).toMatch(/DATABASE_URL is required/);
		}

		const noSettlement = validateReconcileCliInvocation({
			argv: ["node", "reconcile-deposit.ts", "--payment-id", "pay_x", "--fund-tx-ref", "tx"],
			env: {
				DATABASE_URL: "postgres://127.0.0.1:1/nope",
				FP_SETTLEMENT: "",
			},
		});
		expect(noSettlement.ok).toBe(false);
		if (!noSettlement.ok) {
			expect(noSettlement.exitCode).toBe(2);
			expect(noSettlement.message).toMatch(/FP_SETTLEMENT is required/);
			expect(noSettlement.message).not.toMatch(/postgres:\/\/127\.0\.0\.1:1\/nope/);
		}

		const ok = validateReconcileCliInvocation({
			argv: ["node", "reconcile-deposit.ts", "--payment-id", "pay_x", "--fund-tx-ref", "tx_1"],
			env: {
				DATABASE_URL: "postgres://127.0.0.1:5432/flexipay_test",
				FP_SETTLEMENT: "mock",
			},
		});
		expect(ok.ok).toBe(true);
		if (ok.ok) {
			expect(ok.paymentId).toBe("pay_x");
			expect(ok.fundTxRef).toBe("tx_1");
		}
	});
});
