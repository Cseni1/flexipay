import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	loadConfig,
	money,
	ProviderError,
	type FlexiPayConfig,
	type PlannedLeg,
	type ProviderAdapter,
} from "@flexipay/domain";
import {
	createSimProviders,
	MockSettlementAdapter,
	type SimProviders,
} from "@flexipay/adapters-sim";
import type { Db } from "../src/db.ts";
import { newId } from "../src/ids.ts";
import {
	advanceLockAttemptAfterTerminalPayout,
	cancelPayment,
	ClaimReleaseRefusedError,
	completeClaimSettle,
	createPaymentFromQuote,
	fundAndRun,
	persistConfirmedFundDeposit,
	persistPendingFundTxRef,
	recordPasskeyClaimRelease,
	settleFundAmount,
	type OrchestratorAdapters,
} from "../src/orchestrator/index.ts";
import {
	paymentsWaitingOnProviders,
	pollProvidersOnce,
	startProviderPoller,
} from "../src/ops/provider-poller.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

// Money paths of the payment engine (run.ts) that the scenario tests in orchestrator.test.ts do
// not reach: pre-settle failures and collect reversal, post-settle convert failure (vault refund
// plus reversal of collect and convert), failing reversals, replays that meet a failed or
// claimed state, the claim-release guards and the provider poller's own loop.

const CONFIG_DIR = resolve(fileURLToPath(new URL("../../../config", import.meta.url)));
const PAYER = "GDEMOPAYER000000000000000000000000000000000000000000";
const DEST = "GDEMODEST0000000000000000000000000000000000000000000";
const TREASURY = "GDEMOTREASURY0000000000000000000000000000000000000000";
const SEAL_KEY = Buffer.from("a".repeat(64), "hex");

let t: TestServer;
let db: Db;
let config: FlexiPayConfig;
let sim: SimProviders;
let settlement: MockSettlementAdapter;
const clock = { now: new Date("2026-10-23T15:00:00.000Z") };

beforeAll(async () => {
	t = await startTestServer();
	db = t.db;
	const loaded = await loadConfig(CONFIG_DIR);
	if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
	config = loaded.config;
	settlement = new MockSettlementAdapter({ token: "USDC", treasury: TREASURY, feeBps: 100, now: () => clock.now });
	sim = createSimProviders(config);
}, 180_000);

afterAll(async () => {
	await t.stop();
});

function adapters(over: Partial<OrchestratorAdapters> = {}): OrchestratorAdapters {
	return {
		getProvider: (id) => sim.providers.get(id),
		settlement,
		vaultPayer: PAYER,
		now: () => clock.now,
		defaultClaimDestination: DEST,
		claimSealKey: SEAL_KEY,
		...over,
	};
}

/** Wraps one simulated provider; every other provider is the plain simulator. */
function withProvider(
	id: string,
	over: (p: ProviderAdapter) => Partial<ProviderAdapter>,
	base: Partial<OrchestratorAdapters> = {},
): OrchestratorAdapters {
	return adapters({
		...base,
		getProvider: (pid) => {
			const p = sim.providers.get(pid);
			if (!p || pid !== id) return p;
			return {
				id: p.id,
				capabilities: () => p.capabilities(),
				health: () => p.health(),
				quote: (req) => p.quote(req),
				execute: (req) => p.execute(req),
				status: (ref) => p.status(ref),
				reverse: (ref) => p.reverse(ref),
				...over(p),
			};
		},
	});
}

const leg = (kind: PlannedLeg["kind"], rail: string, inA: [string, string], outA: [string, string]): PlannedLeg => ({
	kind,
	rail,
	providerId: rail,
	amountIn: money(inA[0], inA[1]),
	amountOut: money(outA[0], outA[1]),
	simulated: true,
});

const SETTLE_P = "9826856435";
const SETTLE_FEE = "98268564";

const phPayoutRoute: PlannedLeg[] = [
	leg("collect", "sim_bank_us_ach", ["10000", "USD"], ["10000", "USD"]),
	leg("convert", "sim_fx", ["10000", "USD"], ["9925125000", "USDC"]),
	leg("settle", "stellar_usdc", [SETTLE_P, "USDC"], [SETTLE_P, "USDC"]),
	leg("convert", "sim_fx", [SETTLE_P, "USDC"], ["50000", "PHP"]),
	leg("payout", "sim_bank_ph_instapay", ["50000", "PHP"], ["48000", "PHP"]),
];

const claimRoute: PlannedLeg[] = phPayoutRoute.slice(0, 3);

const domesticRoute: PlannedLeg[] = [
	leg("collect", "sim_bank_us_ach", ["10000", "USD"], ["10000", "USD"]),
	leg("payout", "sim_bank_us_ach", ["10000", "USD"], ["10000", "USD"]),
];

async function newPayment(opts: {
	route: PlannedLeg[];
	feeMode?: "PayerPays" | "RecipientPays" | null;
	delivery?: "direct" | "claim_link";
	destination?: Record<string, string>;
}): Promise<{ paymentId: string; orgId: string }> {
	const { orgId } = await t.newOrg("Engine Paths");
	const recipientId = newId("rcp");
	await db.recipient.create({
		data: { id: recipientId, organizationId: orgId, name: "Worker A", kind: "individual", country: "US" },
	});
	const hasSettle = opts.route.some((l) => l.kind === "settle");
	const quoteId = newId("qte");
	const last = opts.route[opts.route.length - 1]!;
	await db.quote.create({
		data: {
			id: quoteId,
			organizationId: orgId,
			source: { type: "bank_account", currency: "USD", country: "US" },
			destination: opts.destination ?? {
				type: "bank_account",
				currency: last.amountOut.currency,
				country: last.amountOut.currency === "USD" ? "US" : "PH",
				recipientKind: "individual",
			},
			amountSide: "send",
			amountValue: "10000",
			amountCurrency: "USD",
			route: opts.route,
			fees: {
				legs: [],
				flexiPayFee: hasSettle ? money(SETTLE_FEE, "USDC") : money("0", "USD"),
				total: money("0", "USD"),
				settleUnlockedRemainder: null,
			},
			fxRate: null,
			expectedReceive: last.amountOut.amount,
			receiveCurrency: last.amountOut.currency,
			priceRiskBearer: "sender",
			policy: "cheapest",
			validUntil: new Date("2099-01-01T00:00:00.000Z"),
			alternatives: [],
			reasons: ["test frozen quote"],
			feeMode: opts.feeMode === undefined ? (hasSettle ? "PayerPays" : null) : opts.feeMode,
			simulated: true,
		},
	});
	const { paymentId } = await createPaymentFromQuote(db, {
		organizationId: orgId,
		recipientId,
		quoteId,
		delivery: opts.delivery ?? "direct",
		profile: "one_off",
	});
	return { paymentId, orgId };
}

const legsOf = (paymentId: string) => db.leg.findMany({ where: { paymentId }, orderBy: { position: "asc" } });
const statusOf = async (paymentId: string) => (await db.payment.findUniqueOrThrow({ where: { id: paymentId } })).status;
const eventTypes = async (paymentId: string) =>
	(await db.event.findMany({ where: { paymentId }, orderBy: { createdAt: "asc" } })).map((e) => e.type);

describe("leg failure before settlement (reverse_collect)", () => {
	it("a convert that fails before the settle leg reverses the collect and refunds; the vault is never touched", async () => {
		sim.controls.reset();
		sim.controls.failNext("sim_fx", 1);
		const { paymentId } = await newPayment({ route: phPayoutRoute });
		const result = await fundAndRun(db, paymentId, adapters());
		expect(result.status).toBe("refunded");
		const legs = await legsOf(paymentId);
		expect(legs.map((l) => l.status)).toEqual(["reversed", "failed", "pending", "pending", "pending"]);
		expect(legs[1]!.errorCode).toBe("sandbox_forced_failure");
		// No fund, no lock: the settle leg never started.
		expect(legs[2]!.externalRef).toBeNull();
		expect(legs[2]!.fundTxRef).toBeNull();
		expect(await eventTypes(paymentId)).toContain("payment.refunded");
	});

	it("a partner refusal (ProviderError) on the collect leg fails it and refunds with nothing to reverse", async () => {
		sim.controls.reset();
		const a = withProvider("sim_bank_us_ach", () => ({
			execute: async () => {
				throw new ProviderError("unsupported", "bank refused the debit");
			},
		}));
		const { paymentId } = await newPayment({ route: domesticRoute });
		expect((await fundAndRun(db, paymentId, a)).status).toBe("refunded");
		const [collect, payout] = await legsOf(paymentId);
		expect(collect!.status).toBe("failed");
		expect(collect!.externalRef).toBeNull();
		expect(collect!.errorMessage).toBe("bank refused the debit");
		expect(payout!.status).toBe("pending");
		const failedEvent = (await db.event.findMany({ where: { paymentId, type: "leg.failed" } }))[0]!;
		// CCR-36: a refused leg has no reference; the event leaves externalRef out.
		expect(failedEvent.snapshot as Record<string, unknown>).not.toHaveProperty("externalRef");
	});

	it("a collect reversal that fails leaves the payment failed, never refunded", async () => {
		sim.controls.reset();
		sim.controls.failNext("sim_fx", 1);
		const a = withProvider("sim_bank_us_ach", () => ({
			reverse: async () => {
				throw new Error("bank reversal timed out");
			},
		}));
		const { paymentId } = await newPayment({ route: phPayoutRoute });
		expect((await fundAndRun(db, paymentId, a)).status).toBe("failed");
		const legs = await legsOf(paymentId);
		// The reversal was started (reversing) but never confirmed.
		expect(legs[0]!.status).toBe("reversing");
		const audit = await db.auditRow.findMany({ where: { paymentId, entity: "payment", toStatus: "failed" } });
		expect(audit.map((a) => a.reason)).toContain("bank reversal timed out");
	});

	it("a collect leg whose provider is not registered fails as unsupported and refunds", async () => {
		sim.controls.reset();
		const a = adapters({ getProvider: (id) => (id === "sim_bank_us_ach" ? undefined : sim.providers.get(id)) });
		const { paymentId } = await newPayment({ route: domesticRoute });
		expect((await fundAndRun(db, paymentId, a)).status).toBe("refunded");
		const [collect] = await legsOf(paymentId);
		expect(collect!.status).toBe("failed");
		expect(collect!.errorCode).toBe("unsupported");
		expect(collect!.errorMessage).toContain("not registered");
	});
});

describe("leg failure after settlement (refund_vault)", () => {
	it("a convert after the settle leg refunds the vault lock and reverses the collect and the first convert", async () => {
		sim.controls.reset();
		const reversals: string[] = [];
		const a = withProvider("sim_fx", (p) => ({
			execute: async (req) => {
				// Only the second convert (USDC to PHP, after settle) fails.
				if (req.amountIn.currency === "USDC") sim.controls.failNext("sim_fx", 1);
				return p.execute(req);
			},
			reverse: async (ref) => {
				reversals.push("convert");
				return p.reverse(ref);
			},
		}));
		const collectProvider = sim.providers.get("sim_bank_us_ach")!;
		const wrapped = a.getProvider;
		a.getProvider = (id) =>
			id === "sim_bank_us_ach"
				? {
						id: collectProvider.id,
						capabilities: () => collectProvider.capabilities(),
						health: () => collectProvider.health(),
						quote: (r) => collectProvider.quote(r),
						execute: (r) => collectProvider.execute(r),
						status: (r) => collectProvider.status(r),
						reverse: async (ref) => {
							reversals.push("collect");
							return collectProvider.reverse(ref);
						},
					}
				: wrapped(id);
		const { paymentId } = await newPayment({ route: phPayoutRoute });
		expect((await fundAndRun(db, paymentId, a)).status).toBe("refunded");
		const legs = await legsOf(paymentId);
		expect(legs.map((l) => l.status)).toEqual(["reversed", "reversed", "succeeded", "failed", "pending"]);
		const settle = legs[2]!;
		expect(settle.externalRef).toBeTruthy();
		expect(settle.releaseTxRef).toBeTruthy();
		expect((await settlement.status(settle.externalRef!)).state).toBe("refunded");
		const onchain = await db.event.findMany({ where: { paymentId, type: "payment.onchain" } });
		expect(onchain.map((e) => (e.snapshot as { phase?: string }).phase)).toContain("refund");
		// Reversals run newest first: convert before collect.
		expect(reversals).toEqual(["convert", "collect"]);
	});

	it("a payout leg that refuses twice with ProviderError is retried once and then refunded through the vault", async () => {
		sim.controls.reset();
		let executes = 0;
		const a = withProvider("sim_bank_ph_instapay", () => ({
			execute: async () => {
				executes += 1;
				throw new ProviderError("insufficient_partner_balance", "Tazapay GBP balance too low for this payout");
			},
		}));
		const { paymentId } = await newPayment({ route: phPayoutRoute });
		expect((await fundAndRun(db, paymentId, a)).status).toBe("refunded");
		expect(executes).toBe(2);
		const payout = (await legsOf(paymentId))[4]!;
		expect(payout.status).toBe("failed");
		expect(payout.attempt).toBe(2);
		expect(payout.errorCode).toBe("insufficient_partner_balance");
		expect(payout.externalRef).toBeNull();
		const failed = await db.event.findMany({ where: { paymentId, type: "leg.failed" } });
		// Order by the attempt each failure was recorded at (timestamps can tie).
		const byAttempt = failed
			.map((e) => e.snapshot as { retry?: boolean; attemptBefore?: number })
			.sort((x, y) => (x.attemptBefore ?? 0) - (y.attemptBefore ?? 0));
		expect(byAttempt.map((e) => [e.attemptBefore, e.retry])).toEqual([
			[1, true],
			[2, false],
		]);
	});

	it("CCR-36 known gap: a partner payout failing after the lock was released cannot refund from the vault and ends failed", async () => {
		sim.controls.reset();
		const a = withProvider(
			"sim_bank_ph_instapay",
			() => ({
				execute: async () => {
					throw new ProviderError("unsupported", "beneficiary refused");
				},
			}),
			{ partnerProviderIds: new Set(["sim_bank_ph_instapay"]) },
		);
		const { paymentId } = await newPayment({ route: phPayoutRoute });
		expect((await fundAndRun(db, paymentId, a)).status).toBe("failed");
		const settle = (await legsOf(paymentId))[2]!;
		// CCR-33 released the lock before the partner leg; the refund cannot come from the vault.
		expect((await settlement.status(settle.externalRef!)).state).toBe("claimed");
		expect(settle.errorCode).toBe("refund_failed");
		expect(settle.errorMessage).toMatch(/refund failed/);
	});

	// Fixed 7 Nov (was BUG): run.ts executeLeg failed a leg whose provider is not registered at
	// attempt 1. For a payout after settlement, runPendingLegs then calls handleLegFailure, where
	// decideOnFailure answers "retry" and handleLegFailure throws "CCR-14 retry must be handled
	// while leg is still processing" (run.ts ~1431-1435). fundAndRun rejects, the payment stays
	// `processing` with a failed payout and an unreleased vault lock, and the provider poller never
	// picks it up again (no processing leg, not every leg succeeded). Expected: the missing
	// provider goes through the CCR-14 path (retry, then refund) like any other leg failure.
	it("a payout whose provider is not registered after settlement is refunded, not stuck (fixed)", async () => {
		sim.controls.reset();
		const a = adapters({ getProvider: (id) => (id === "sim_bank_ph_instapay" ? undefined : sim.providers.get(id)) });
		const { paymentId } = await newPayment({ route: phPayoutRoute });
		const result = await fundAndRun(db, paymentId, a);
		expect(["refunded", "failed"]).toContain(result.status);
	});
});

describe("replays and resumption", () => {
	it("an error that is not a ProviderError propagates and leaves the leg processing; the replay re-runs the same attempt", async () => {
		sim.controls.reset();
		let boom = true;
		const a = withProvider("sim_bank_us_ach", (p) => ({
			execute: async (req) => {
				if (req.kind === "payout" && boom) {
					boom = false;
					throw new Error("socket hang up");
				}
				return p.execute(req);
			},
		}));
		const { paymentId } = await newPayment({ route: domesticRoute });
		await expect(fundAndRun(db, paymentId, a)).rejects.toThrow("socket hang up");
		const payout = (await legsOf(paymentId))[1]!;
		expect(payout.status).toBe("processing");
		expect(payout.externalRef).toBeNull();
		expect(payout.attempt).toBe(1);
		expect((await fundAndRun(db, paymentId, a)).status).toBe("paid");
		expect((await legsOf(paymentId))[1]!.attempt).toBe(1);
	});

	it("the poller resumes a partner leg that the partner later reports failed: retry once, then paid", async () => {
		sim.controls.reset();
		let phase: "processing" | "failed" | "real" = "processing";
		const a = withProvider("sim_bank_ph_instapay", (p) => ({
			status: async (ref) => {
				if (phase === "processing") return { status: "processing" as const, externalRef: ref };
				if (phase === "failed") {
					phase = "real";
					return { status: "failed" as const, externalRef: ref, error: { code: "provider_down" as const, message: "partner rejected" } };
				}
				return p.status(ref);
			},
		}));
		const { paymentId } = await newPayment({ route: phPayoutRoute });
		expect((await fundAndRun(db, paymentId, a)).status).toBe("processing");
		const firstRef = (await legsOf(paymentId))[4]!.externalRef;
		expect(firstRef).toBeTruthy();
		expect(await paymentsWaitingOnProviders(db)).toContain(paymentId);

		phase = "failed";
		expect(await pollProvidersOnce(db, a)).toBeGreaterThanOrEqual(1);
		expect(await statusOf(paymentId)).toBe("paid");
		const payout = (await legsOf(paymentId))[4]!;
		expect(payout.attempt).toBe(2);
		expect(payout.externalRef).not.toBe(firstRef);
	});

	it("a replayed partner leg whose status read reports failure on the second attempt refunds the payment", async () => {
		sim.controls.reset();
		let failing = false;
		const a = withProvider("sim_bank_ph_instapay", () => ({
			status: async (ref) =>
				failing
					? { status: "failed" as const, externalRef: ref }
					: { status: "processing" as const, externalRef: ref },
		}));
		const { paymentId } = await newPayment({ route: phPayoutRoute });
		expect((await fundAndRun(db, paymentId, a)).status).toBe("processing");
		failing = true;
		// Attempt 1 fails on the status read, attempt 2 fails right after execute: refund.
		expect((await fundAndRun(db, paymentId, a)).status).toBe("refunded");
		const payout = (await legsOf(paymentId))[4]!;
		expect(payout.attempt).toBe(2);
		// Without an error from the partner the code falls back to provider_down.
		expect(payout.errorCode).toBe("provider_down");
	});

	it("the poller marks a payment paid when every leg already succeeded (CCR-33 change 3)", async () => {
		sim.controls.reset();
		const { paymentId } = await newPayment({ route: domesticRoute });
		expect((await fundAndRun(db, paymentId, adapters())).status).toBe("paid");
		// Simulate a crash between the last leg and the final transition.
		await db.payment.update({ where: { id: paymentId }, data: { status: "processing" } });
		expect(await paymentsWaitingOnProviders(db)).toContain(paymentId);
		await pollProvidersOnce(db, adapters());
		expect(await statusOf(paymentId)).toBe("paid");
		expect(await paymentsWaitingOnProviders(db)).not.toContain(paymentId);
	});

	it("the poller logs a failing payment and still resumes the others", async () => {
		sim.controls.reset();
		const broken = await newPayment({ route: domesticRoute });
		const ok = await newPayment({ route: domesticRoute });
		const a = withProvider("sim_bank_us_ach", (p) => ({
			status: async (ref) => {
				if (ref.includes(broken.paymentId)) throw new Error("partner API 500");
				return p.status(ref);
			},
		}));
		const waitFirst = withProvider("sim_bank_us_ach", () => ({
			status: async (ref) => ({ status: "processing" as const, externalRef: ref }),
		}));
		// Both payments stop at a collect leg that waits on the partner.
		expect((await fundAndRun(db, broken.paymentId, waitFirst)).status).toBe("processing");
		expect((await fundAndRun(db, ok.paymentId, waitFirst)).status).toBe("processing");
		const lines: string[] = [];
		await pollProvidersOnce(db, a, (m) => lines.push(m));
		expect(lines.some((l) => l.includes(broken.paymentId) && l.includes("partner API 500"))).toBe(true);
		expect(await statusOf(ok.paymentId)).toBe("paid");
		expect(await statusOf(broken.paymentId)).toBe("processing");
	});

	it("a funded payment moves to processing and runs; paid and refunded payments are returned as they are", async () => {
		sim.controls.reset();
		const { paymentId } = await newPayment({ route: domesticRoute });
		await db.payment.update({ where: { id: paymentId }, data: { status: "funded" } });
		expect((await fundAndRun(db, paymentId, adapters())).status).toBe("paid");
		const types = await eventTypes(paymentId);
		expect(types).toContain("payment.processing");
		expect(types).not.toContain("payment.funded");
		const before = (await db.event.count({ where: { paymentId } }));
		expect((await fundAndRun(db, paymentId, adapters())).status).toBe("paid");
		expect(await db.event.count({ where: { paymentId } })).toBe(before);
	});

	it("refuses to fund a cancelled payment, and cancel refuses a paid one", async () => {
		sim.controls.reset();
		const cancelled = await newPayment({ route: domesticRoute });
		expect((await cancelPayment(db, cancelled.paymentId)).status).toBe("cancelled");
		await expect(fundAndRun(db, cancelled.paymentId, adapters())).rejects.toThrow(/cannot fund payment in status cancelled/);
		const paid = await newPayment({ route: domesticRoute });
		await fundAndRun(db, paid.paymentId, adapters());
		await expect(cancelPayment(db, paid.paymentId)).rejects.toThrow(/cannot cancel payment in status paid/);
	});

	it("a settle route whose quote lost its feeMode is refused before any money moves (CCR-13)", async () => {
		sim.controls.reset();
		const { paymentId } = await newPayment({ route: phPayoutRoute });
		// create.ts refuses this at create time; an old row (or a manual edit) can still lack it.
		const row = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
		await db.quote.update({ where: { id: row.quoteId }, data: { feeMode: null } });
		await expect(fundAndRun(db, paymentId, adapters())).rejects.toThrow(/feeMode missing/);
		const legs = await legsOf(paymentId);
		// Funded and processing, but no leg ran.
		expect(legs.every((l) => l.status === "pending")).toBe(true);
	});

	it("a failed leg found on replay (crash before the failure was handled) is refunded", async () => {
		sim.controls.reset();
		const { paymentId } = await newPayment({ route: domesticRoute });
		await db.payment.update({ where: { id: paymentId }, data: { status: "processing" } });
		const [collect] = await legsOf(paymentId);
		await db.leg.update({ where: { id: collect!.id }, data: { status: "failed", errorCode: "provider_down" } });
		expect((await fundAndRun(db, paymentId, adapters())).status).toBe("refunded");
	});

	it("a settle leg left processing after its lock was already released (claimed) is completed on replay without a second lock", async () => {
		sim.controls.reset();
		let partnerDone = false;
		const a = withProvider(
			"sim_bank_ph_instapay",
			(p) => ({
				status: async (ref) => (partnerDone ? p.status(ref) : { status: "processing" as const, externalRef: ref }),
			}),
			{ partnerProviderIds: new Set(["sim_bank_ph_instapay"]) },
		);
		const { paymentId } = await newPayment({ route: phPayoutRoute });
		expect((await fundAndRun(db, paymentId, a)).status).toBe("processing");
		const settle = (await legsOf(paymentId))[2]!;
		expect((await settlement.status(settle.externalRef!)).state).toBe("claimed");
		// Rewind the settle leg as if the success write was lost after the release.
		await db.leg.update({ where: { id: settle.id }, data: { status: "processing" } });
		const locks = await db.event.count({ where: { paymentId, type: "payment.onchain" } });
		partnerDone = true;
		expect((await fundAndRun(db, paymentId, a)).status).toBe("paid");
		const after = (await legsOf(paymentId))[2]!;
		expect(after.status).toBe("succeeded");
		expect(after.externalRef).toBe(settle.externalRef);
		const phases = (await db.event.findMany({ where: { paymentId, type: "payment.onchain" } })).map(
			(e) => (e.snapshot as { phase?: string }).phase,
		);
		expect(phases.filter((p) => p === "lock")).toHaveLength(1);
		expect(phases.length).toBe(locks);
	});
});

describe("claim release guards (completeClaimSettle / recordPasskeyClaimRelease)", () => {
	async function waitingClaim() {
		sim.controls.reset();
		const p = await newPayment({
			route: claimRoute,
			delivery: "claim_link",
			destination: { type: "crypto_wallet", currency: "USDC", country: "PH", recipientKind: "individual" },
		});
		expect((await fundAndRun(db, p.paymentId, adapters())).status).toBe("processing");
		return p;
	}

	it("passkey release: records the tx once, accepts the claim, pays; the same ref is idempotent, a different ref is refused", async () => {
		const { paymentId } = await waitingClaim();
		const first = await recordPasskeyClaimRelease(db, paymentId, adapters(), "tx_passkey_1");
		expect(first.status).toBe("paid");
		const link = await db.claimLink.findUniqueOrThrow({ where: { paymentId } });
		expect(link.status).toBe("accepted");
		const settle = (await legsOf(paymentId))[2]!;
		expect(settle.releaseTxRef).toBe("tx_passkey_1");
		// Paid now: a second call is refused for status, the release is never recorded twice.
		await expect(recordPasskeyClaimRelease(db, paymentId, adapters(), "tx_passkey_1")).rejects.toThrow(/requires processing/);
		expect(await db.event.count({ where: { paymentId, type: "claim.accepted" } })).toBe(1);
	});

	it("passkey release replay while still processing: same ref returns, a different ref throws", async () => {
		const { paymentId } = await waitingClaim();
		const settle = (await legsOf(paymentId))[2]!;
		await db.leg.update({ where: { id: settle.id }, data: { releaseTxRef: "tx_a" } });
		expect((await recordPasskeyClaimRelease(db, paymentId, adapters(), "tx_a")).status).toBe("processing");
		await expect(recordPasskeyClaimRelease(db, paymentId, adapters(), "tx_b")).rejects.toThrow(/different tx ref/);
		// Custodial release is idempotent too once a release ref exists.
		expect((await completeClaimSettle(db, paymentId, adapters(), { destination: DEST })).status).toBe("processing");
	});

	it("a claim whose settle leg failed is refused for both release paths (CCR-15)", async () => {
		const { paymentId } = await waitingClaim();
		const settle = (await legsOf(paymentId))[2]!;
		await db.leg.update({ where: { id: settle.id }, data: { status: "failed", errorCode: "refund_failed" } });
		await expect(recordPasskeyClaimRelease(db, paymentId, adapters(), "tx_x")).rejects.toBeInstanceOf(ClaimReleaseRefusedError);
		await expect(completeClaimSettle(db, paymentId, adapters(), { destination: DEST })).rejects.toBeInstanceOf(ClaimReleaseRefusedError);
	});

	it("custodial release refuses a wrong secret and a settle leg that is not waiting", async () => {
		const { paymentId } = await waitingClaim();
		await expect(
			completeClaimSettle(db, paymentId, adapters(), { destination: DEST, secretHex: "00".repeat(32) }),
		).rejects.toThrow(/claim secret mismatch/);
		const settle = (await legsOf(paymentId))[2]!;
		expect(settle.releaseTxRef).toBeNull();
		await db.leg.update({ where: { id: settle.id }, data: { externalRef: null } });
		await expect(completeClaimSettle(db, paymentId, adapters(), { destination: DEST })).rejects.toThrow(/not waiting for release/);
		await expect(recordPasskeyClaimRelease(db, paymentId, adapters(), "tx_y")).rejects.toThrow(/not waiting for release/);
	});

	it("a claim with the seal removed cannot be released (CCR-11)", async () => {
		const { paymentId } = await waitingClaim();
		await db.claimLink.update({ where: { paymentId }, data: { secretSealed: null, secretSealedNonce: null } });
		await expect(completeClaimSettle(db, paymentId, adapters(), { destination: DEST })).rejects.toThrow(/seal missing/);
	});

	it("custodial release of a direct claim to a classic G address binds it for SEP-10", async () => {
		const { paymentId } = await waitingClaim();
		const classic = `G${"A".repeat(55)}`;
		expect((await completeClaimSettle(db, paymentId, adapters(), { destination: classic })).status).toBe("paid");
		const link = await db.claimLink.findUniqueOrThrow({ where: { paymentId } });
		expect(link.recipientClassicAddress).toBe(classic);
	});
});

describe("CCR-23 deposit identity helpers", () => {
	it("persistPendingFundTxRef writes once, accepts the same hash and refuses a different one", async () => {
		const { paymentId } = await newPayment({ route: domesticRoute });
		const legId = (await legsOf(paymentId))[0]!.id;
		expect(await persistPendingFundTxRef(db, legId, "fund_a")).toBe("written");
		expect(await persistPendingFundTxRef(db, legId, "fund_a")).toBe("already_same");
		await expect(persistPendingFundTxRef(db, legId, "fund_b")).rejects.toThrow(/different fundTxRef/);
	});

	it("persistConfirmedFundDeposit completes a pending hash, is idempotent and refuses another identity", async () => {
		const { paymentId } = await newPayment({ route: domesticRoute });
		const legId = (await legsOf(paymentId))[0]!.id;
		const dep = {
			fundTxRef: "fund_c",
			fundOpIndex: 0,
			fundAmountValue: "100",
			fundAmountCurrency: "USDC",
			fundNetwork: "mock",
			fundVaultId: "vault_1",
		};
		await persistPendingFundTxRef(db, legId, "fund_c");
		expect(await persistConfirmedFundDeposit(db, legId, dep)).toBe("written");
		expect(await persistConfirmedFundDeposit(db, legId, dep)).toBe("already_same");
		await expect(persistConfirmedFundDeposit(db, legId, { ...dep, fundTxRef: "fund_d" })).rejects.toThrow(/different confirmed deposit/);

		const other = (await legsOf(paymentId))[1]!.id;
		expect(await persistConfirmedFundDeposit(db, other, { ...dep, fundTxRef: "fund_e" })).toBe("written");
	});

	it("settleFundAmount adds the fee only for PayerPays and refuses a fee in another currency", () => {
		const legRow = { amountInValue: "1000", amountInCurrency: "USDC" };
		expect(settleFundAmount(legRow, money("10", "USDC"), "PayerPays")).toEqual(money("1010", "USDC"));
		expect(settleFundAmount(legRow, money("10", "USDC"), "RecipientPays")).toEqual(money("1000", "USDC"));
		expect(() => settleFundAmount(legRow, money("10", "USD"), "PayerPays")).toThrow(/currency mismatch/);
	});

	it("advanceLockAttemptAfterTerminalPayout refuses without a confirmed deposit, or while the payout is not refunded", async () => {
		sim.controls.reset();
		const noSettle = await newPayment({ route: domesticRoute });
		await expect(advanceLockAttemptAfterTerminalPayout(db, noSettle.paymentId, adapters())).rejects.toThrow(/without confirmed deposit/);

		const claim = await newPayment({
			route: claimRoute,
			delivery: "claim_link",
			destination: { type: "crypto_wallet", currency: "USDC", country: "PH", recipientKind: "individual" },
		});
		await fundAndRun(db, claim.paymentId, adapters());
		await expect(advanceLockAttemptAfterTerminalPayout(db, claim.paymentId, adapters())).rejects.toThrow(/payout state is pending/);
		await db.payment.update({ where: { id: claim.paymentId }, data: { lockAttempt: 0 } });
		await expect(advanceLockAttemptAfterTerminalPayout(db, claim.paymentId, adapters())).rejects.toThrow(/no prior attempt/);
	});
});

describe("startProviderPoller", () => {
	it("runs on its interval, skips overlapping passes, logs a failed pass and stops", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			let calls = 0;
			let release!: () => void;
			const fakeDb = {
				leg: {
					findMany: () => {
						calls += 1;
						if (calls === 1) return new Promise<never>((_r, reject) => (release = () => reject(new Error("db down"))));
						return Promise.resolve([]);
					},
				},
				payment: { findMany: () => Promise.resolve([]) },
			} as unknown as Db;
			const stop = startProviderPoller(fakeDb, adapters(), 1000);
			vi.advanceTimersByTime(1000);
			expect(calls).toBe(1);
			// The first pass is still running: the next tick is skipped.
			vi.advanceTimersByTime(1000);
			expect(calls).toBe(1);
			release();
			await new Promise((r) => setTimeout(r, 20));
			expect(errors.mock.calls.some((c) => String(c[0]).includes("provider poller: db down"))).toBe(true);
			vi.advanceTimersByTime(1000);
			expect(calls).toBe(2);
			stop();
			vi.advanceTimersByTime(5000);
			expect(calls).toBe(2);
		} finally {
			errors.mockRestore();
			vi.useRealTimers();
		}
	});
});
