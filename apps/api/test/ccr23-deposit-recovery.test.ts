import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	VaultTxFeeError,
	type VaultTxFeeRejectReason,
} from "@flexipay/adapter-stellar";
import {
	FundDepositVerifyError,
	loadConfig,
	money,
	type FlexiPayConfig,
	type PlannedLeg,
} from "@flexipay/domain";
import {
	createSimProviders,
	MockSettlementAdapter,
	type SimProviders,
} from "@flexipay/adapters-sim";
import type { Db } from "../src/db.ts";
import { newId } from "../src/ids.ts";
import {
	ReconcileDepositError,
	reconcileDepositToPayment,
} from "../src/ops/reconcile-deposit.ts";
import {
	advanceLockAttemptAfterTerminalPayout,
	createPaymentFromQuote,
	fundAndRun,
	type OrchestratorAdapters,
} from "../src/orchestrator/index.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

const CONFIG_DIR = resolve(
	fileURLToPath(new URL("../../../config", import.meta.url)),
);
const PAYER = "GDEMOPAYER000000000000000000000000000000000000000000";
const DEST = "GDEMODEST0000000000000000000000000000000000000000000";
const TEST_SEAL_KEY = Buffer.from("a".repeat(64), "hex");

let t: TestServer;
let db: Db;
let config: FlexiPayConfig;
let sim: SimProviders;
let clock: { now: Date };

beforeAll(async () => {
	process.env.FP_CLAIM_SEAL_KEY = "a".repeat(64);
	t = await startTestServer();
	db = t.db;
	const loaded = await loadConfig(CONFIG_DIR);
	if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
	config = loaded.config;
	clock = { now: new Date("2026-10-25T18:00:00.000Z") };
	sim = createSimProviders(config);
}, 180_000);

afterAll(async () => {
	if (t) await t.stop();
});

function freshVault() {
	return new MockSettlementAdapter({
		token: "USDC",
		treasury: "GDEMOTREASURY0000000000000000000000000000000000000000",
		feeBps: 100,
		now: () => clock.now,
		vaultId: "mock-payout-vault",
	});
}

function adaptersFor(vault: MockSettlementAdapter): OrchestratorAdapters {
	return {
		getProvider: (id) => sim.providers.get(id),
		settlement: vault,
		vaultPayer: PAYER,
		now: () => clock.now,
		defaultClaimDestination: DEST,
		claimSealKey: TEST_SEAL_KEY,
	};
}

async function seedClaimSettlePayment(vault: MockSettlementAdapter) {
	const { orgId } = await t.newOrg("CCR23 Org");
	const recipientId = newId("rcp");
	await db.recipient.create({
		data: {
			id: recipientId,
			organizationId: orgId,
			name: "Worker A",
			kind: "individual",
			country: "US",
		},
	});
	const route: PlannedLeg[] = [
		{
			kind: "settle",
			rail: "stellar_usdc",
			providerId: "stellar_usdc",
			amountIn: money("10000000", "USDC"),
			amountOut: money("9900000", "USDC"),
			simulated: true,
		},
	];
	const quoteId = newId("qte");
	await db.quote.create({
		data: {
			id: quoteId,
			organizationId: orgId,
			source: { type: "bank_account", currency: "USD", country: "US" },
			destination: {
				type: "crypto_wallet",
				currency: "USDC",
				country: "PH",
				recipientKind: "individual",
			},
			amountSide: "send",
			amountValue: "10000000",
			amountCurrency: "USDC",
			route,
			fees: {
				legs: [
					{
						kind: "settle",
						rail: "stellar_usdc",
						fee: money("100000", "USDC"),
					},
				],
				flexiPayFee: money("100000", "USDC"),
				total: money("100000", "USDC"),
				settleUnlockedRemainder: null,
			},
			fxRate: null,
			expectedReceive: "9900000",
			receiveCurrency: "USDC",
			priceRiskBearer: "sender",
			policy: "cheapest",
			validUntil: new Date(clock.now.getTime() + 3_600_000),
			alternatives: [],
			reasons: ["ccr23-fixture"],
			feeMode: "PayerPays",
			simulated: true,
		},
	});
	const { paymentId } = await createPaymentFromQuote(db, {
		organizationId: orgId,
		recipientId,
		quoteId,
		delivery: "claim_link",
		profile: "one_off",
		now: clock.now,
	});
	return { orgId, paymentId, adapters: adaptersFor(vault) };
}

describe("CCR-23 deposit recovery", () => {
	it("confirmed deposit then fund replay: zero second deposit; same lockAttempt", async () => {
		sim.controls.reset();
		const vault = freshVault();
		let funds = 0;
		const orig = vault.fundVault.bind(vault);
		vault.fundVault = async (payer, amount) => {
			funds += 1;
			return orig(payer, amount);
		};
		const { paymentId, adapters } = await seedClaimSettlePayment(vault);

		await fundAndRun(db, paymentId, adapters);
		const afterFirst = await db.payment.findUniqueOrThrow({
			where: { id: paymentId },
			include: { legs: true },
		});
		const settle = afterFirst.legs.find((l) => l.kind === "settle")!;
		expect(settle.fundTxRef).toBeTruthy();
		expect(typeof settle.fundOpIndex).toBe("number");
		expect(afterFirst.lockAttempt).toBe(1);
		expect(funds).toBe(1);

		await fundAndRun(db, paymentId, adapters);
		expect(funds).toBe(1);
		const afterReplay = await db.payment.findUniqueOrThrow({
			where: { id: paymentId },
		});
		expect(afterReplay.lockAttempt).toBe(1);
	});

	it("failed lock then replay keeps lockAttempt and does not re-fund", async () => {
		sim.controls.reset();
		const vault = freshVault();
		let funds = 0;
		let locks = 0;
		const origFund = vault.fundVault.bind(vault);
		const origLock = vault.lock.bind(vault);
		vault.fundVault = async (payer, amount) => {
			funds += 1;
			return origFund(payer, amount);
		};
		vault.lock = async (req) => {
			locks += 1;
			if (locks === 1) throw new Error("simulated lock failure");
			return origLock(req);
		};
		const { paymentId, adapters } = await seedClaimSettlePayment(vault);

		await expect(fundAndRun(db, paymentId, adapters)).rejects.toThrow(
			/simulated lock failure/,
		);
		const mid = await db.payment.findUniqueOrThrow({
			where: { id: paymentId },
			include: { legs: true },
		});
		const settle = mid.legs.find((l) => l.kind === "settle")!;
		expect(settle.fundTxRef).toBeTruthy();
		expect(settle.externalRef).toBeNull();
		expect(mid.lockAttempt).toBe(1);
		expect(funds).toBe(1);

		await fundAndRun(db, paymentId, adapters);
		expect(funds).toBe(1);
		expect(locks).toBe(2);
		const done = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
		expect(done.lockAttempt).toBe(1);
	});

	it("two payments cannot bind the same deposit identity", async () => {
		sim.controls.reset();
		const vault = freshVault();
		const a = await seedClaimSettlePayment(vault);
		const b = await seedClaimSettlePayment(vault);
		await fundAndRun(db, a.paymentId, a.adapters);
		const settleA = await db.leg.findFirstOrThrow({
			where: { paymentId: a.paymentId, kind: "settle" },
		});
		expect(settleA.fundTxRef).toBeTruthy();

		await expect(
			reconcileDepositToPayment(db, vault, {
				paymentId: b.paymentId,
				fundTxRef: settleA.fundTxRef!,
				payer: PAYER,
				amount: money("10100000", "USDC"),
			}),
		).rejects.toBeInstanceOf(ReconcileDepositError);
	});

	it("VaultTxFeeError on lock keeps fundTxRef, does not bump attempt or re-fund", async () => {
		sim.controls.reset();
		const vault = freshVault();
		let funds = 0;
		const origFund = vault.fundVault.bind(vault);
		vault.fundVault = async (payer, amount) => {
			funds += 1;
			return origFund(payer, amount);
		};
		vault.lock = async () => {
			throw new VaultTxFeeError(
				"fee_exceeds_ceiling" satisfies VaultTxFeeRejectReason,
				"total fee exceeds configured ceiling",
				{ totalFee: 500_000n, ceiling: 100_000n },
			);
		};
		const { paymentId, adapters } = await seedClaimSettlePayment(vault);
		const err = await fundAndRun(db, paymentId, adapters).catch((e) => e);
		expect(err).toBeInstanceOf(VaultTxFeeError);
		expect((err as VaultTxFeeError).reason).toBe("fee_exceeds_ceiling");

		const mid = await db.payment.findUniqueOrThrow({
			where: { id: paymentId },
			include: { legs: true },
		});
		expect(mid.lockAttempt).toBe(1);
		expect(mid.legs.find((l) => l.kind === "settle")!.fundTxRef).toBeTruthy();
		expect(funds).toBe(1);

		const err2 = await fundAndRun(db, paymentId, adapters).catch((e) => e);
		expect(err2).toBeInstanceOf(VaultTxFeeError);
		expect((err2 as VaultTxFeeError).reason).toBe("fee_exceeds_ceiling");
		expect(funds).toBe(1);
		expect(
			(await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).lockAttempt,
		).toBe(1);
	});

	it("uncertain lock (findLock miss after failure) does not bump attempt or re-fund", async () => {
		sim.controls.reset();
		const vault = freshVault();
		let funds = 0;
		const origFund = vault.fundVault.bind(vault);
		vault.fundVault = async (payer, amount) => {
			funds += 1;
			return origFund(payer, amount);
		};
		vault.lock = async () => {
			throw new Error("timeout");
		};
		vault.findLock = async () => undefined;
		const { paymentId, adapters } = await seedClaimSettlePayment(vault);
		await expect(fundAndRun(db, paymentId, adapters)).rejects.toThrow(/timeout/);
		await expect(fundAndRun(db, paymentId, adapters)).rejects.toThrow(/timeout/);
		expect(funds).toBe(1);
		expect(
			(await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).lockAttempt,
		).toBe(1);
	});

	it("attempt bump only after refunded payout with CAS + audit", async () => {
		sim.controls.reset();
		const vault = freshVault();
		const { paymentId, adapters } = await seedClaimSettlePayment(vault);
		await fundAndRun(db, paymentId, adapters);
		const settle = await db.leg.findFirstOrThrow({
			where: { paymentId, kind: "settle" },
		});
		expect(settle.externalRef).toBeTruthy();
		await vault.refund(settle.externalRef!);

		const advanced = await advanceLockAttemptAfterTerminalPayout(
			db,
			paymentId,
			adapters,
		);
		expect(advanced).toEqual({ previousAttempt: 1, nextAttempt: 2 });
		const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
		expect(payment.lockAttempt).toBe(2);
		const audits = await db.auditRow.findMany({ where: { paymentId } });
		expect(
			audits.some((a) => a.reason === "lock_attempt_advanced_after_refund"),
		).toBe(true);

		await expect(
			advanceLockAttemptAfterTerminalPayout(db, paymentId, adapters),
		).rejects.toThrow(/cannot advance lockAttempt/);
	});

	it("reconcile lock/CAS/audit; multiple matching deposits rejected", async () => {
		sim.controls.reset();
		const vault = freshVault();
		const { paymentId } = await seedClaimSettlePayment(vault);
		const fund = await vault.fundVault(PAYER, money("10100000", "USDC"));
		vault.recordAdditionalDepositOnTx(fund.txRef, {
			payer: PAYER,
			amount: money("10100000", "USDC"),
			opIndex: 1,
		});
		await expect(
			reconcileDepositToPayment(db, vault, {
				paymentId,
				fundTxRef: fund.txRef,
				payer: PAYER,
				amount: money("10100000", "USDC"),
			}),
		).rejects.toBeInstanceOf(FundDepositVerifyError);

		const vault2 = freshVault();
		const { paymentId: pay2 } = await seedClaimSettlePayment(vault2);
		const fund2 = await vault2.fundVault(PAYER, money("10100000", "USDC"));
		const ok = await reconcileDepositToPayment(db, vault2, {
			paymentId: pay2,
			fundTxRef: fund2.txRef,
			payer: PAYER,
			amount: money("10100000", "USDC"),
		});
		expect(ok.outcome).toBe("written");
		expect(ok.fundOpIndex).toBe(0);
		const settle = await db.leg.findFirstOrThrow({
			where: { paymentId: pay2, kind: "settle" },
		});
		expect(settle.fundTxRef).toBe(fund2.txRef);
		const events = await db.event.findMany({ where: { paymentId: pay2 } });
		expect(
			events.some(
				(e) => (e.snapshot as { phase?: string }).phase === "fund_reconcile",
			),
		).toBe(true);
	});
});
