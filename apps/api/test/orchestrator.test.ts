import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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
	completeClaimSettle,
	createPaymentFromQuote,
	fundAndRun,
	getPaymentView,
	type OrchestratorAdapters,
} from "../src/orchestrator/index.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

const CONFIG_DIR = resolve(fileURLToPath(new URL("../../../config", import.meta.url)));
const PAYER = "GDEMOPAYER000000000000000000000000000000000000000000";
const DEST = "GDEMODEST0000000000000000000000000000000000000000000";
/** Demo-only seal key for tests (64 hex). Not a real secret. */
const TEST_SEAL_KEY = Buffer.from(
	"a".repeat(64),
	"hex",
);

let t: TestServer;
let db: Db;
let config: FlexiPayConfig;
let sim: SimProviders;
let settlement: MockSettlementAdapter;
let clock: { now: Date };

beforeAll(async () => {
	process.env.FP_CLAIM_SEAL_KEY = "a".repeat(64);
	t = await startTestServer();
	db = t.db;
	const loaded = await loadConfig(CONFIG_DIR);
	if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
	config = loaded.config;
	clock = { now: new Date("2026-10-23T15:00:00.000Z") };
	settlement = new MockSettlementAdapter({
		token: "USDC",
		treasury: "GDEMOTREASURY0000000000000000000000000000000000000000",
		feeBps: 100,
		now: () => clock.now,
	});
	sim = createSimProviders(config);
}, 180_000);

afterAll(async () => {
	await t.stop();
});

function adapters(): OrchestratorAdapters {
	return {
		getProvider: (id) => sim.providers.get(id),
		settlement,
		vaultPayer: PAYER,
		now: () => clock.now,
		defaultClaimDestination: DEST,
		claimSealKey: TEST_SEAL_KEY,
	};
}

async function seedQuote(
	orgId: string,
	opts: {
		feeMode: "PayerPays" | "RecipientPays" | null;
		route: PlannedLeg[];
		fees: {
			legs: { kind: string; rail: string; fee: { amount: string; currency: string } }[];
			flexiPayFee: { amount: string; currency: string };
			total: { amount: string; currency: string };
			settleUnlockedRemainder: { amount: string; currency: string } | null;
		};
		destination: {
			type: string;
			currency: string;
			country: string;
			recipientKind: string;
		};
	},
) {
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
	const quoteId = newId("qte");
	await db.quote.create({
		data: {
			id: quoteId,
			organizationId: orgId,
			source: { type: "bank_account", currency: "USD", country: "US" },
			destination: opts.destination,
			amountSide: "send",
			amountValue: "10000",
			amountCurrency: "USD",
			route: opts.route,
			fees: opts.fees,
			fxRate: null,
			expectedReceive: opts.route[opts.route.length - 1]!.amountOut.amount,
			receiveCurrency: opts.route[opts.route.length - 1]!.amountOut.currency,
			priceRiskBearer: "sender",
			policy: "cheapest",
			validUntil: new Date("2099-01-01T00:00:00.000Z"),
			alternatives: [],
			reasons: ["test frozen quote"],
			feeMode: opts.feeMode,
			simulated: true,
		},
	});
	return { recipientId, quoteId };
}

const domesticRoute: PlannedLeg[] = [
	{
		kind: "collect",
		rail: "sim_bank_us_ach",
		providerId: "sim_bank_us_ach",
		amountIn: money("10000", "USD"),
		amountOut: money("10000", "USD"),
		simulated: true,
	},
	{
		kind: "payout",
		rail: "sim_bank_us_ach",
		providerId: "sim_bank_us_ach",
		amountIn: money("10000", "USD"),
		amountOut: money("10000", "USD"),
		simulated: true,
	},
];

const cryptoClaimRoute: PlannedLeg[] = [
	{
		kind: "collect",
		rail: "sim_bank_us_ach",
		providerId: "sim_bank_us_ach",
		amountIn: money("10000", "USD"),
		amountOut: money("10000", "USD"),
		simulated: true,
	},
	{
		kind: "convert",
		rail: "sim_fx",
		providerId: "sim_fx",
		amountIn: money("10000", "USD"),
		amountOut: money("9925125000", "USDC"),
		simulated: true,
	},
	{
		kind: "settle",
		rail: "stellar_usdc",
		providerId: "stellar_usdc",
		amountIn: money("9826856435", "USDC"),
		amountOut: money("9826856435", "USDC"),
		simulated: true,
	},
];

const phPayoutRoute: PlannedLeg[] = [
	{
		kind: "collect",
		rail: "sim_bank_us_ach",
		providerId: "sim_bank_us_ach",
		amountIn: money("10000", "USD"),
		amountOut: money("10000", "USD"),
		simulated: true,
	},
	{
		kind: "convert",
		rail: "sim_fx",
		providerId: "sim_fx",
		amountIn: money("10000", "USD"),
		amountOut: money("9925125000", "USDC"),
		simulated: true,
	},
	{
		kind: "settle",
		rail: "stellar_usdc",
		providerId: "stellar_usdc",
		amountIn: money("9826856435", "USDC"),
		amountOut: money("9826856435", "USDC"),
		simulated: true,
	},
	{
		kind: "convert",
		rail: "sim_fx",
		providerId: "sim_fx",
		amountIn: money("9826856435", "USDC"),
		amountOut: money("50000", "PHP"),
		simulated: true,
	},
	{
		kind: "payout",
		rail: "sim_bank_ph_instapay",
		providerId: "sim_bank_ph_instapay",
		amountIn: money("50000", "PHP"),
		amountOut: money("48000", "PHP"),
		simulated: true,
	},
];

describe("CC2 orchestrator (CCR-11–14)", () => {
	it("create-from-quote copies frozen amounts; domestic reaches paid", async () => {
		sim.controls.reset();
		const { orgId } = await t.newOrg("Demo Platform");
		const { recipientId, quoteId } = await seedQuote(orgId, {
			feeMode: null,
			route: domesticRoute,
			fees: {
				legs: [
					{ kind: "collect", rail: "sim_bank_us_ach", fee: money("0", "USD") },
					{ kind: "payout", rail: "sim_bank_us_ach", fee: money("0", "USD") },
				],
				flexiPayFee: money("0", "USD"),
				total: money("0", "USD"),
				settleUnlockedRemainder: null,
			},
			destination: {
				type: "bank_account",
				currency: "USD",
				country: "US",
				recipientKind: "individual",
			},
		});

		const { paymentId } = await createPaymentFromQuote(db, {
			organizationId: orgId,
			recipientId,
			quoteId,
			delivery: "direct",
			profile: "domestic",
		});

		const legs = await db.leg.findMany({
			where: { paymentId },
			orderBy: { position: "asc" },
		});
		expect(legs.map((l) => l.amountInValue)).toEqual(["10000", "10000"]);

		const result = await fundAndRun(db, paymentId, adapters());
		expect(result.status).toBe("paid");
	});

	it("PayerPays: settle externalRef=payoutId, lockTxRef set; feeMode from quote", async () => {
		sim.controls.reset();
		const { orgId } = await t.newOrg("Demo Platform");
		const P = "9826856435";
		const fee = "98268564"; // f(P) at 100 bps
		const { recipientId, quoteId } = await seedQuote(orgId, {
			feeMode: "PayerPays",
			route: cryptoClaimRoute,
			fees: {
				legs: [
					{ kind: "collect", rail: "sim_bank_us_ach", fee: money("0", "USD") },
					{ kind: "convert", rail: "sim_fx", fee: money("125", "USD") },
					{ kind: "settle", rail: "stellar_usdc", fee: money(fee, "USDC") },
				],
				flexiPayFee: money(fee, "USDC"),
				total: money("125", "USD"),
				settleUnlockedRemainder: money("1", "USDC"),
			},
			destination: {
				type: "crypto_wallet",
				currency: "USDC",
				country: "PH",
				recipientKind: "individual",
			},
		});

		const { paymentId } = await createPaymentFromQuote(db, {
			organizationId: orgId,
			recipientId,
			quoteId,
			delivery: "claim_link",
			profile: "one_off",
		});

		const funded = await fundAndRun(db, paymentId, adapters());
		expect(funded.status).toBe("processing");

		const settle = await db.leg.findFirstOrThrow({
			where: { paymentId, kind: "settle" },
		});
		expect(settle.amountInValue).toBe(P);
		expect(settle.externalRef).toBeTruthy();
		expect(settle.lockTxRef).toBeTruthy();
		expect(settle.releaseTxRef).toBeNull();
		// payoutId must not look like we stored lock hash as externalRef incorrectly —
		// mock payout ids are distinct from tx refs.
		expect(settle.externalRef).not.toBe(settle.lockTxRef);

		const quote = await db.quote.findUniqueOrThrow({ where: { id: quoteId } });
		expect(quote.feeMode).toBe("PayerPays");

		const link = await db.claimLink.findUniqueOrThrow({ where: { paymentId } });
		expect(link.vaultClaimHashHex).toMatch(/^[0-9a-f]{64}$/);
		expect(link.secretSealed).toBeTruthy();
		expect(link.secretSealedNonce).toBeTruthy();

		const events = await db.event.findMany({ where: { paymentId } });
		const blob = JSON.stringify(events.map((e) => e.snapshot));
		expect(blob).not.toMatch(/secretSealed/);
		expect(blob).not.toMatch(/secretHex/);
	});

	it("CCR-11 restart-custody: claim release after new adapters object (DB seal only; not same-call replay)", async () => {
		// Distinguishes custody restart from fundAndRun replay:
		// - Replay = same adapters + fundAndRun again (covered elsewhere).
		// - Restart-custody = discard prior OrchestratorAdapters; load secret from ClaimLink seal.
		// Mock vault state still lives in this process (stellar would share on-chain).
		sim.controls.reset();
		const { orgId } = await t.newOrg("Demo Platform");
		const { recipientId, quoteId } = await seedQuote(orgId, {
			feeMode: "PayerPays",
			route: cryptoClaimRoute,
			fees: {
				legs: [
					{ kind: "collect", rail: "sim_bank_us_ach", fee: money("0", "USD") },
					{ kind: "convert", rail: "sim_fx", fee: money("125", "USD") },
					{ kind: "settle", rail: "stellar_usdc", fee: money("98268564", "USDC") },
				],
				flexiPayFee: money("98268564", "USDC"),
				total: money("125", "USD"),
				settleUnlockedRemainder: money("1", "USDC"),
			},
			destination: {
				type: "crypto_wallet",
				currency: "USDC",
				country: "PH",
				recipientKind: "individual",
			},
		});

		const { paymentId } = await createPaymentFromQuote(db, {
			organizationId: orgId,
			recipientId,
			quoteId,
			delivery: "claim_link",
			profile: "one_off",
		});
		const fundingAdapters = adapters();
		await fundAndRun(db, paymentId, fundingAdapters);

		const link = await db.claimLink.findUniqueOrThrow({ where: { paymentId } });
		expect(link.secretSealed).toBeTruthy();

		// New adapters instance — no retained secret handle from fundingAdapters.
		const restartAdapters: OrchestratorAdapters = {
			getProvider: (id) => sim.providers.get(id),
			settlement,
			vaultPayer: PAYER,
			now: () => clock.now,
			defaultClaimDestination: DEST,
			claimSealKey: Buffer.from("a".repeat(64), "hex"),
		};
		expect(restartAdapters).not.toBe(fundingAdapters);

		const done = await completeClaimSettle(db, paymentId, restartAdapters, {
			destination: DEST,
		});
		expect(done.status).toBe("paid");

		const settle = await db.leg.findFirstOrThrow({
			where: { paymentId, kind: "settle" },
		});
		expect(settle.releaseTxRef).toBeTruthy();
		expect(settle.releaseTxRef).not.toBe(settle.externalRef);
		expect(settle.releaseTxRef).not.toBe(settle.lockTxRef);
	});

	it("CCR-13: PayerPays fundVault(P+quotedFee); RecipientPays fundVault(P only); lock fee matches quote", async () => {
		sim.controls.reset();
		const funds: { amount: string; currency: string }[] = [];
		const tracking = new MockSettlementAdapter({
			token: "USDC",
			treasury: "GDEMOTREASURY0000000000000000000000000000000000000000",
			feeBps: 100,
			now: () => clock.now,
		});
		const origFund = tracking.fundVault.bind(tracking);
		tracking.fundVault = async (payer, amount) => {
			funds.push({ amount: amount.amount, currency: amount.currency });
			return origFund(payer, amount);
		};

		const P = "9826856435";
		const fee = "98268564";
		const runMode = async (feeMode: "PayerPays" | "RecipientPays") => {
			funds.length = 0;
			const { orgId } = await t.newOrg("Demo Platform");
			const route =
				feeMode === "PayerPays"
					? cryptoClaimRoute
					: [
							cryptoClaimRoute[0]!,
							cryptoClaimRoute[1]!,
							{
								...cryptoClaimRoute[2]!,
								// RecipientPays: amountIn = A, amountOut = A - f(A)
								amountIn: money("9925125000", "USDC"),
								amountOut: money("9825873750", "USDC"),
							},
						];
			const flexi =
				feeMode === "PayerPays"
					? money(fee, "USDC")
					: money("99251250", "USDC");
			const { recipientId, quoteId } = await seedQuote(orgId, {
				feeMode,
				route,
				fees: {
					legs: [
						{ kind: "collect", rail: "sim_bank_us_ach", fee: money("0", "USD") },
						{ kind: "convert", rail: "sim_fx", fee: money("125", "USD") },
						{ kind: "settle", rail: "stellar_usdc", fee: flexi },
					],
					flexiPayFee: flexi,
					total: money("125", "USD"),
					settleUnlockedRemainder:
						feeMode === "PayerPays" ? money("1", "USDC") : null,
				},
				destination: {
					type: "crypto_wallet",
					currency: "USDC",
					country: "PH",
					recipientKind: "individual",
				},
			});
			const { paymentId } = await createPaymentFromQuote(db, {
				organizationId: orgId,
				recipientId,
				quoteId,
				delivery: "claim_link",
				profile: "one_off",
			});
			await fundAndRun(db, paymentId, {
				...adapters(),
				settlement: tracking,
			});
			const settleFund = funds[funds.length - 1]!;
			if (feeMode === "PayerPays") {
				expect(settleFund.amount).toBe(
					(BigInt(P) + BigInt(fee)).toString(),
				);
			} else {
				expect(settleFund.amount).toBe("9925125000");
			}
			expect(settleFund.currency).toBe("USDC");
		};

		await runMode("PayerPays");
		await runMode("RecipientPays");
	});

	it("exactly one payout retry then success; no third execute", async () => {
		sim.controls.reset();
		sim.controls.failNext("sim_bank_ph_instapay", 1);

		let payoutExecutes = 0;
		const counting: OrchestratorAdapters = {
			...adapters(),
			getProvider: (id) => {
				const p = sim.providers.get(id);
				if (!p || id !== "sim_bank_ph_instapay") return p;
				return {
					id: p.id,
					capabilities: () => p.capabilities(),
					health: () => p.health(),
					quote: (req) => p.quote(req),
					execute: async (req) => {
						payoutExecutes += 1;
						return p.execute(req);
					},
					status: (ref) => p.status(ref),
					reverse: (ref) => p.reverse(ref),
				};
			},
		};

		const { orgId } = await t.newOrg("Demo Platform");
		const { recipientId, quoteId } = await seedQuote(orgId, {
			feeMode: "PayerPays",
			route: phPayoutRoute,
			fees: {
				legs: [
					{ kind: "collect", rail: "sim_bank_us_ach", fee: money("0", "USD") },
					{ kind: "convert", rail: "sim_fx", fee: money("125", "USD") },
					{ kind: "settle", rail: "stellar_usdc", fee: money("98268564", "USDC") },
					{ kind: "convert", rail: "sim_fx", fee: money("0", "USDC") },
					{ kind: "payout", rail: "sim_bank_ph_instapay", fee: money("2000", "PHP") },
				],
				flexiPayFee: money("98268564", "USDC"),
				total: money("125", "USD"),
				settleUnlockedRemainder: money("1", "USDC"),
			},
			destination: {
				type: "bank_account",
				currency: "PHP",
				country: "PH",
				recipientKind: "individual",
			},
		});

		const { paymentId } = await createPaymentFromQuote(db, {
			organizationId: orgId,
			recipientId,
			quoteId,
			delivery: "direct",
			profile: "one_off",
		});

		const result = await fundAndRun(db, paymentId, counting);
		expect(result.status).toBe("paid");
		expect(payoutExecutes).toBe(2);

		const view = await getPaymentView(db, paymentId);
		const payout = view.legs.find((l) => l.kind === "payout");
		expect(payout?.attempt).toBe(2);

		const audits = await db.auditRow.findMany({
			where: { paymentId, entity: "leg" },
		});
		expect(
			audits.some((a) => /CCR-14 retry attempt 1 -> 2/.test(a.reason ?? "")),
		).toBe(true);
	});

	it("two payout failures → refund; no third execute; refunded only after refund ok", async () => {
		sim.controls.reset();
		sim.controls.failNext("sim_bank_ph_instapay", 2);

		let payoutExecutes = 0;
		const counting: OrchestratorAdapters = {
			...adapters(),
			getProvider: (id) => {
				const p = sim.providers.get(id);
				if (!p || id !== "sim_bank_ph_instapay") return p;
				return {
					id: p.id,
					capabilities: () => p.capabilities(),
					health: () => p.health(),
					quote: (req) => p.quote(req),
					execute: async (req) => {
						payoutExecutes += 1;
						return p.execute(req);
					},
					status: (ref) => p.status(ref),
					reverse: (ref) => p.reverse(ref),
				};
			},
		};

		const { orgId } = await t.newOrg("Demo Platform");
		const { recipientId, quoteId } = await seedQuote(orgId, {
			feeMode: "PayerPays",
			route: phPayoutRoute,
			fees: {
				legs: [
					{ kind: "collect", rail: "sim_bank_us_ach", fee: money("0", "USD") },
					{ kind: "convert", rail: "sim_fx", fee: money("125", "USD") },
					{ kind: "settle", rail: "stellar_usdc", fee: money("98268564", "USDC") },
					{ kind: "convert", rail: "sim_fx", fee: money("0", "USDC") },
					{ kind: "payout", rail: "sim_bank_ph_instapay", fee: money("2000", "PHP") },
				],
				flexiPayFee: money("98268564", "USDC"),
				total: money("125", "USD"),
				settleUnlockedRemainder: money("1", "USDC"),
			},
			destination: {
				type: "bank_account",
				currency: "PHP",
				country: "PH",
				recipientKind: "individual",
			},
		});

		const { paymentId } = await createPaymentFromQuote(db, {
			organizationId: orgId,
			recipientId,
			quoteId,
			delivery: "direct",
			profile: "one_off",
		});

		const result = await fundAndRun(db, paymentId, counting);
		expect(result.status).toBe("refunded");
		expect(payoutExecutes).toBe(2);

		const settle = await db.leg.findFirstOrThrow({
			where: { paymentId, kind: "settle" },
		});
		expect(settle.releaseTxRef).toBeTruthy();
	});

	it("replay does not duplicate collect/lock/release", async () => {
		sim.controls.reset();
		const { orgId } = await t.newOrg("Demo Platform");
		const { recipientId, quoteId } = await seedQuote(orgId, {
			feeMode: null,
			route: domesticRoute,
			fees: {
				legs: [
					{ kind: "collect", rail: "sim_bank_us_ach", fee: money("0", "USD") },
					{ kind: "payout", rail: "sim_bank_us_ach", fee: money("0", "USD") },
				],
				flexiPayFee: money("0", "USD"),
				total: money("0", "USD"),
				settleUnlockedRemainder: null,
			},
			destination: {
				type: "bank_account",
				currency: "USD",
				country: "US",
				recipientKind: "individual",
			},
		});

		const { paymentId } = await createPaymentFromQuote(db, {
			organizationId: orgId,
			recipientId,
			quoteId,
			delivery: "direct",
			profile: "domestic",
		});

		await fundAndRun(db, paymentId, adapters());
		const first = await getPaymentView(db, paymentId);
		const refs = first.legs.map((l) => l.externalRef);

		await fundAndRun(db, paymentId, adapters());
		const second = await getPaymentView(db, paymentId);
		expect(second.status).toBe("paid");
		expect(second.legs.map((l) => l.externalRef)).toEqual(refs);
	});

	it("failed refund does not mark payment refunded", async () => {
		sim.controls.reset();
		sim.controls.failNext("sim_bank_ph_instapay", 2);

		const boomSettlement = new MockSettlementAdapter({
			token: "USDC",
			treasury: "GDEMOTREASURY0000000000000000000000000000000000000000",
			feeBps: 100,
			now: () => clock.now,
		});
		const origRefund = boomSettlement.refund.bind(boomSettlement);
		let refundCalls = 0;
		boomSettlement.refund = async (payoutId: string) => {
			refundCalls += 1;
			if (refundCalls === 1) throw new Error("simulated refund failure");
			return origRefund(payoutId);
		};

		const { orgId } = await t.newOrg("Demo Platform");
		const { recipientId, quoteId } = await seedQuote(orgId, {
			feeMode: "PayerPays",
			route: phPayoutRoute,
			fees: {
				legs: [
					{ kind: "collect", rail: "sim_bank_us_ach", fee: money("0", "USD") },
					{ kind: "convert", rail: "sim_fx", fee: money("125", "USD") },
					{ kind: "settle", rail: "stellar_usdc", fee: money("98268564", "USDC") },
					{ kind: "convert", rail: "sim_fx", fee: money("0", "USDC") },
					{ kind: "payout", rail: "sim_bank_ph_instapay", fee: money("2000", "PHP") },
				],
				flexiPayFee: money("98268564", "USDC"),
				total: money("125", "USD"),
				settleUnlockedRemainder: money("1", "USDC"),
			},
			destination: {
				type: "bank_account",
				currency: "PHP",
				country: "PH",
				recipientKind: "individual",
			},
		});

		const { paymentId } = await createPaymentFromQuote(db, {
			organizationId: orgId,
			recipientId,
			quoteId,
			delivery: "direct",
			profile: "one_off",
		});

		const result = await fundAndRun(db, paymentId, {
			...adapters(),
			settlement: boomSettlement,
		});
		expect(result.status).toBe("failed");
		expect(result.status).not.toBe("refunded");
	});
});
