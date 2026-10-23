import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	loadConfig,
	money,
	type FlexiPayConfig,
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
	createPaymentFromPlan,
	fundAndRun,
	getPaymentView,
	type ExecutionPlan,
	type OrchestratorAdapters,
} from "../src/orchestrator/index.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

const CONFIG_DIR = resolve(fileURLToPath(new URL("../../../config", import.meta.url)));
const PAYER = "GDEMOPAYER000000000000000000000000000000000000000000";
const DEST = "GDEMODEST0000000000000000000000000000000000000000000";

let t: TestServer;
let db: Db;
let config: FlexiPayConfig;
let sim: SimProviders;
let settlement: MockSettlementAdapter;
let clock: { now: Date };

beforeAll(async () => {
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
	};
}

async function seedQuoteAndRecipient(orgId: string, feeMode: "PayerPays" | "RecipientPays" | null) {
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
			destination: {
				type: "bank_account",
				currency: "USD",
				country: "US",
				recipientKind: "individual",
			},
			amountSide: "send",
			amountValue: "10000",
			amountCurrency: "USD",
			route: [],
			fees: { legs: [], flexiPayFee: money("0", "USD"), total: money("0", "USD") },
			fxRate: null,
			expectedReceive: "10000",
			receiveCurrency: "USD",
			priceRiskBearer: "sender",
			policy: "cheapest",
			validUntil: new Date("2026-10-23T15:02:00.000Z"),
			alternatives: [],
			reasons: ["test plan"],
			simulated: true,
		},
	});
	void feeMode;
	return { recipientId, quoteId };
}

describe("CC2 orchestrator", () => {
	it("runs legs in order and reaches paid only when the last leg succeeds", async () => {
		sim.controls.reset();
		const { orgId } = await t.newOrg("Demo Platform");
		const { recipientId, quoteId } = await seedQuoteAndRecipient(orgId, null);

		const plan: ExecutionPlan = {
			feeMode: null,
			claimWaitSettle: false,
			lockExpiresAt: new Date("2026-10-24T15:00:00.000Z"),
			payoutEndpoint: {
				endpointId: "ep_us",
				type: "bank_account",
				country: "US",
				currency: "USD",
			},
			legs: [
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
			],
		};

		const { paymentId } = await createPaymentFromPlan(db, {
			organizationId: orgId,
			recipientId,
			quoteId,
			delivery: "direct",
			profile: "domestic",
			plan,
		});

		const mid = await getPaymentView(db, paymentId);
		expect(mid.status).toBe("awaiting_funding");
		expect(mid.legs.map((l) => l.status)).toEqual(["pending", "pending"]);

		const result = await fundAndRun(db, paymentId, adapters(), plan);
		expect(result.status).toBe("paid");

		const view = await getPaymentView(db, paymentId);
		expect(view.legs.map((l) => l.status)).toEqual(["succeeded", "succeeded"]);
		expect(view.legs.every((l) => l.externalRef)).toBe(true);

		const events = await db.event.findMany({
			where: { paymentId },
			orderBy: { createdAt: "asc" },
		});
		expect(events.map((e) => e.type)).toEqual(
			expect.arrayContaining([
				"payment.created",
				"payment.funded",
				"payment.processing",
				"leg.succeeded",
				"payment.paid",
			]),
		);
		const audits = await db.auditRow.findMany({ where: { paymentId } });
		expect(audits.length).toBeGreaterThan(3);
	});

	it("claim crypto route: lock leaves settle processing; paid only after release", async () => {
		sim.controls.reset();
		const { orgId } = await t.newOrg("Demo Platform");
		const { recipientId, quoteId } = await seedQuoteAndRecipient(
			orgId,
			"RecipientPays",
		);

		const plan: ExecutionPlan = {
			feeMode: "RecipientPays",
			claimWaitSettle: true,
			claimDestination: DEST,
			lockExpiresAt: new Date("2026-10-24T15:00:00.000Z"),
			legs: [
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
					amountOut: money("992512500", "USDC"),
					simulated: true,
				},
				{
					kind: "settle",
					rail: "stellar_usdc",
					providerId: "stellar_usdc",
					amountIn: money("992512500", "USDC"),
					amountOut: money("982587375", "USDC"),
					simulated: false,
				},
			],
		};

		const { paymentId } = await createPaymentFromPlan(db, {
			organizationId: orgId,
			recipientId,
			quoteId,
			delivery: "claim_link",
			profile: "one_off",
			plan,
		});

		const funded = await fundAndRun(db, paymentId, adapters(), plan);
		expect(funded.status).toBe("processing");
		expect(funded.claimSecretHex).toMatch(/^[0-9a-f]+$/);

		const waiting = await getPaymentView(db, paymentId);
		expect(waiting.legs.map((l) => l.status)).toEqual([
			"succeeded",
			"succeeded",
			"processing",
		]);
		expect(waiting.legs[2]?.externalRef).toBeTruthy();

		// Replay fundAndRun must not lock again.
		const locksBefore = await settlement.status(waiting.legs[2]!.externalRef!);
		expect(locksBefore.state).toBe("pending");
		await fundAndRun(db, paymentId, adapters(), plan);
		const locksAfter = await settlement.status(waiting.legs[2]!.externalRef!);
		expect(locksAfter.state).toBe("pending");

		const done = await completeClaimSettle(db, paymentId, adapters(), {
			secretHex: funded.claimSecretHex!,
			destination: DEST,
		});
		expect(done.status).toBe("paid");

		const view = await getPaymentView(db, paymentId);
		expect(view.legs.map((l) => l.status)).toEqual([
			"succeeded",
			"succeeded",
			"succeeded",
		]);
		const onchain = await db.event.findMany({
			where: { paymentId, type: "payment.onchain" },
		});
		expect(onchain.length).toBeGreaterThanOrEqual(2);
	});

	it("retries a failed payout exactly once, then succeeds", async () => {
		sim.controls.reset();
		sim.controls.failNext("sim_bank_us_ach", 1);

		const { orgId } = await t.newOrg("Demo Platform");
		const { recipientId, quoteId } = await seedQuoteAndRecipient(
			orgId,
			"RecipientPays",
		);

		const plan: ExecutionPlan = {
			feeMode: "RecipientPays",
			claimWaitSettle: false,
			claimDestination: DEST,
			lockExpiresAt: new Date("2026-10-24T15:00:00.000Z"),
			payoutEndpoint: {
				endpointId: "ep_us",
				type: "bank_account",
				country: "US",
				currency: "USD",
			},
			legs: [
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
					amountOut: money("992512500", "USDC"),
					simulated: true,
				},
				{
					kind: "settle",
					rail: "stellar_usdc",
					providerId: "stellar_usdc",
					amountIn: money("992512500", "USDC"),
					amountOut: money("982587375", "USDC"),
					simulated: false,
				},
				{
					kind: "convert",
					rail: "sim_fx",
					providerId: "sim_fx",
					amountIn: money("982587375", "USDC"),
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
			],
		};

		// failNext on sim_bank_us_ach would also fail collect — use separate collect success
		// by failing only after collect: mark forced failure after collect via failNext on payout-only...
		// sim_bank_us_ach does both collect and payout. failNext(1) fails the first execute (collect).
		// Reset and fail the payout provider id that is only used for payout — use PH bank for payout.
		sim.controls.reset();

		const phPlan: ExecutionPlan = {
			...plan,
			payoutEndpoint: {
				endpointId: "ep_ph",
				type: "bank_account",
				country: "PH",
				currency: "PHP",
			},
			legs: [
				plan.legs[0]!,
				plan.legs[1]!,
				plan.legs[2]!,
				{
					kind: "convert",
					rail: "sim_fx",
					providerId: "sim_fx",
					amountIn: money("982587375", "USDC"),
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
			],
		};

		sim.controls.failNext("sim_bank_ph_instapay", 1);

		const { paymentId } = await createPaymentFromPlan(db, {
			organizationId: orgId,
			recipientId,
			quoteId,
			delivery: "direct",
			profile: "one_off",
			plan: phPlan,
		});

		const result = await fundAndRun(db, paymentId, adapters(), phPlan);
		expect(result.status).toBe("paid");

		const view = await getPaymentView(db, paymentId);
		const payout = view.legs.find((l) => l.kind === "payout" as never) ?? view.legs[4];
		expect(payout?.attempt).toBe(2);
		expect(payout?.status).toBe("succeeded");

		const failedEvents = await db.event.findMany({
			where: { paymentId, type: "leg.failed" },
		});
		expect(failedEvents.length).toBe(1);
	});

	it("after two payout failures refunds via SettlementAdapter and reverses earlier legs", async () => {
		sim.controls.reset();
		sim.controls.failNext("sim_bank_ph_instapay", 2);

		const { orgId } = await t.newOrg("Demo Platform");
		const { recipientId, quoteId } = await seedQuoteAndRecipient(
			orgId,
			"RecipientPays",
		);

		const plan: ExecutionPlan = {
			feeMode: "RecipientPays",
			claimWaitSettle: false,
			claimDestination: DEST,
			lockExpiresAt: new Date("2026-10-24T15:00:00.000Z"),
			payoutEndpoint: {
				endpointId: "ep_ph",
				type: "bank_account",
				country: "PH",
				currency: "PHP",
			},
			legs: [
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
					amountOut: money("992512500", "USDC"),
					simulated: true,
				},
				{
					kind: "settle",
					rail: "stellar_usdc",
					providerId: "stellar_usdc",
					amountIn: money("992512500", "USDC"),
					amountOut: money("982587375", "USDC"),
					simulated: false,
				},
				{
					kind: "convert",
					rail: "sim_fx",
					providerId: "sim_fx",
					amountIn: money("982587375", "USDC"),
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
			],
		};

		const { paymentId } = await createPaymentFromPlan(db, {
			organizationId: orgId,
			recipientId,
			quoteId,
			delivery: "direct",
			profile: "one_off",
			plan,
		});

		const result = await fundAndRun(db, paymentId, adapters(), plan);
		expect(result.status).toBe("refunded");

		const view = await getPaymentView(db, paymentId);
		expect(view.legs[0]?.status).toBe("reversed");
		expect(view.legs[1]?.status).toBe("reversed");
		expect(view.legs[4]?.status).toBe("failed");
		expect(view.legs[4]?.attempt).toBe(2);

		const refunded = await db.event.findFirst({
			where: { paymentId, type: "payment.refunded" },
		});
		expect(refunded).toBeTruthy();
	});

	it("does not re-execute a succeeded leg when fundAndRun is called again", async () => {
		sim.controls.reset();
		const { orgId } = await t.newOrg("Demo Platform");
		const { recipientId, quoteId } = await seedQuoteAndRecipient(orgId, null);

		const plan: ExecutionPlan = {
			feeMode: null,
			claimWaitSettle: false,
			lockExpiresAt: new Date("2026-10-24T15:00:00.000Z"),
			payoutEndpoint: {
				endpointId: "ep_us",
				type: "bank_account",
				country: "US",
				currency: "USD",
			},
			legs: [
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
			],
		};

		const { paymentId } = await createPaymentFromPlan(db, {
			organizationId: orgId,
			recipientId,
			quoteId,
			delivery: "direct",
			profile: "domestic",
			plan,
		});

		await fundAndRun(db, paymentId, adapters(), plan);
		const first = await getPaymentView(db, paymentId);
		const refs = first.legs.map((l) => l.externalRef);

		await fundAndRun(db, paymentId, adapters(), plan);
		const second = await getPaymentView(db, paymentId);
		expect(second.status).toBe("paid");
		expect(second.legs.map((l) => l.externalRef)).toEqual(refs);
	});
});
