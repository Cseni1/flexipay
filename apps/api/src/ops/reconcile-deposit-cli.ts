/** Pure CLI/env gate for scripts/ops/reconcile-deposit.ts — no DB URL logging. */

export function argFrom(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(`--${name}`);
	if (i < 0) return undefined;
	return argv[i + 1];
}

export function validateReconcileCliInvocation(input: {
	argv: string[];
	env: Record<string, string | undefined>;
}):
	| { ok: true; paymentId: string; fundTxRef: string; databaseUrl: string }
	| { ok: false; exitCode: number; message: string } {
	if (argFrom(input.argv, "database-url") !== undefined) {
		return {
			ok: false,
			exitCode: 2,
			message:
				"--database-url is not accepted; set DATABASE_URL in the environment only",
		};
	}

	const databaseUrl = input.env.DATABASE_URL?.trim();
	if (!databaseUrl) {
		return {
			ok: false,
			exitCode: 2,
			message: "DATABASE_URL is required in the environment",
		};
	}

	if (!input.env.FP_SETTLEMENT?.trim()) {
		return {
			ok: false,
			exitCode: 2,
			message: "FP_SETTLEMENT is required (mock|stellar); no code default",
		};
	}

	const paymentId = argFrom(input.argv, "payment-id")?.trim();
	if (!paymentId) {
		return { ok: false, exitCode: 2, message: "missing --payment-id" };
	}
	const fundTxRef = argFrom(input.argv, "fund-tx-ref")?.trim();
	if (!fundTxRef) {
		return { ok: false, exitCode: 2, message: "missing --fund-tx-ref" };
	}

	const amountValue = argFrom(input.argv, "amount")?.trim();
	if (amountValue !== undefined && !/^[0-9]+$/.test(amountValue)) {
		return {
			ok: false,
			exitCode: 2,
			message: "--amount must be an integer minor-unit string",
		};
	}

	return { ok: true, paymentId, fundTxRef, databaseUrl };
}
