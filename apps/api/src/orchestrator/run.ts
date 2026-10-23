import { createHash, randomBytes } from "node:crypto";
import {
	decideOnFailure,
	isPaid,
	nextLegIndex,
	type FeeMode,
	type LegKind,
	type LegStatus,
	type Money,
	type PaymentStatus,
} from "@flexipay/domain";
import type { Db } from "../db.ts";
import { newId, sha256Hex } from "../ids.ts";
import {
	emitPaymentEvent,
	paymentSnapshot,
	transitionLeg,
	transitionPayment,
} from "./persist.ts";
import type {
	CreatePaymentInput,
	ExecutionPlan,
	OrchestratorAdapters,
} from "./types.ts";

/**
 * In-process claim secrets for crypto claim-wait (ARCHITECTURE §7).
 * Prisma ClaimLink has no claimHashHex / secret column — durable storage needs a
 * contract change. Secrets are returned once from fundAndRun and required again on
 * completeClaimSettle; they are not recovered after process restart.
 */
const claimSecrets = new Map<string, { secretHex: string; claimHashHex: string }>();

function moneyOf(value: string, currency: string): Money {
	return { amount: value, currency };
}

function legStates(
	legs: { kind: string; status: string }[],
): { kind: LegKind; status: LegStatus }[] {
	return legs.map((l) => ({
		kind: l.kind as LegKind,
		status: l.status as LegStatus,
	}));
}

/**
 * Creates a payment + pending legs from an explicit plan. Expects the Quote and
 * Recipient rows to already exist (FK). Status starts at `awaiting_funding`.
 */
export async function createPaymentFromPlan(
	db: Db,
	input: CreatePaymentInput,
): Promise<{ paymentId: string }> {
	const { plan } = input;
	if (plan.legs.some((l) => l.kind === "settle") && plan.feeMode === null) {
		throw new Error(
			"feeMode is required when the execution plan includes a settle leg (CCR-8)",
		);
	}

	const paymentId = newId("pay");
	await db.payment.create({
		data: {
			id: paymentId,
			organizationId: input.organizationId,
			quoteId: input.quoteId,
			recipientId: input.recipientId,
			externalId: input.externalId ?? null,
			delivery: input.delivery,
			profile: input.profile,
			reference: input.reference ?? null,
			status: "awaiting_funding",
			lockAttempt: 0,
			legs: {
				create: plan.legs.map((leg, position) => ({
					id: newId("leg"),
					position,
					kind: leg.kind,
					rail: leg.rail,
					providerId: leg.providerId,
					amountInValue: leg.amountIn.amount,
					amountInCurrency: leg.amountIn.currency,
					amountOutValue: leg.amountOut.amount,
					amountOutCurrency: leg.amountOut.currency,
					status: "pending",
					attempt: 1,
					simulated: leg.simulated,
				})),
			},
		},
	});

	await db.auditRow.create({
		data: {
			id: newId("aud"),
			paymentId,
			entity: "payment",
			entityId: paymentId,
			fromStatus: null,
			toStatus: "awaiting_funding",
			reason: "createPaymentFromPlan",
		},
	});
	await emitPaymentEvent(db, input.organizationId, paymentId, "payment.created");

	if (input.delivery === "claim_link") {
		const token = randomBytes(24).toString("hex");
		await db.claimLink.create({
			data: {
				paymentId,
				tokenHash: sha256Hex(token),
				expiresAt: plan.lockExpiresAt,
				status: "open",
			},
		});
		await emitPaymentEvent(db, input.organizationId, paymentId, "claim.opened", {
			// Raw token only for the creating caller in CC3; not persisted in clear text.
			tokenIssued: true,
		});
	}

	return { paymentId };
}

export interface FundResult {
	paymentId: string;
	status: PaymentStatus;
	/** Present once for claim-wait settle; caller must retain for completeClaimSettle. */
	claimSecretHex?: string;
}

/**
 * Marks the payment funded and runs legs in order inside this call (ARCHITECTURE §1a / §7).
 * Replay-safe: a succeeded leg with an externalRef is not executed again; a processing leg
 * with a ref is polled via status() instead of a second execute/lock.
 */
export async function fundAndRun(
	db: Db,
	paymentId: string,
	adapters: OrchestratorAdapters,
	plan: ExecutionPlan,
): Promise<FundResult> {
	const payment = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
		include: { legs: { orderBy: { position: "asc" } } },
	});
	if (payment.status === "paid" || payment.status === "refunded") {
		return { paymentId, status: payment.status as PaymentStatus };
	}
	if (
		payment.status !== "awaiting_funding" &&
		payment.status !== "funded" &&
		payment.status !== "processing"
	) {
		throw new Error(`cannot fund payment in status ${payment.status}`);
	}

	if (payment.status === "awaiting_funding") {
		await transitionPayment(
			db,
			paymentId,
			payment.organizationId,
			"awaiting_funding",
			"funded",
		);
		await transitionPayment(
			db,
			paymentId,
			payment.organizationId,
			"funded",
			"processing",
		);
	} else if (payment.status === "funded") {
		await transitionPayment(
			db,
			paymentId,
			payment.organizationId,
			"funded",
			"processing",
		);
	}

	let claimSecretHex: string | undefined;
	if (plan.claimWaitSettle) {
		const existing = claimSecrets.get(paymentId);
		if (existing) claimSecretHex = existing.secretHex;
		else {
			const secretHex = randomBytes(32).toString("hex");
			const claimHashHex = createHash("sha256")
				.update(Buffer.from(secretHex, "hex"))
				.digest("hex");
			claimSecrets.set(paymentId, { secretHex, claimHashHex });
			claimSecretHex = secretHex;
		}
	}

	await runPendingLegs(db, paymentId, adapters, plan);

	const after = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
		include: { legs: { orderBy: { position: "asc" } } },
	});
	return {
		paymentId,
		status: after.status as PaymentStatus,
		claimSecretHex,
	};
}

async function runPendingLegs(
	db: Db,
	paymentId: string,
	adapters: OrchestratorAdapters,
	plan: ExecutionPlan,
): Promise<void> {
	for (;;) {
		const payment = await db.payment.findUniqueOrThrow({
			where: { id: paymentId },
			include: { legs: { orderBy: { position: "asc" } } },
		});
		if (payment.status !== "processing") return;

		const states = legStates(payment.legs);
		if (isPaid(states)) {
			await releasePendingSettle(db, paymentId, adapters, plan);
			await transitionPayment(
				db,
				paymentId,
				payment.organizationId,
				"processing",
				"paid",
			);
			return;
		}

		let idx = nextLegIndex(states);
		if (idx === undefined) {
			const processing = payment.legs.find((l) => l.status === "processing");
			const failed = payment.legs.find((l) => l.status === "failed");
			if (
				processing?.kind === "settle" &&
				plan.claimWaitSettle &&
				processing.externalRef
			) {
				return; // lock done; wait for completeClaimSettle
			}
			if (processing) {
				idx = processing.position;
			} else if (failed) {
				await handleLegFailure(db, paymentId, failed.id, adapters, plan);
				continue;
			} else {
				return;
			}
		}

		const leg = payment.legs[idx]!;
		const planned = plan.legs[idx]!;
		await executeLeg(db, payment, leg, planned, adapters, plan);

		const refreshed = await db.leg.findUniqueOrThrow({ where: { id: leg.id } });
		if (refreshed.status === "failed") {
			await handleLegFailure(db, paymentId, leg.id, adapters, plan);
		}
	}
}

async function executeLeg(
	db: Db,
	payment: { id: string; organizationId: string; lockAttempt: number },
	leg: {
		id: string;
		kind: string;
		status: string;
		attempt: number;
		externalRef: string | null;
		providerId: string;
		amountInValue: string;
		amountInCurrency: string;
		amountOutValue: string;
		amountOutCurrency: string;
		rail: string;
	},
	planned: ExecutionPlan["legs"][number],
	adapters: OrchestratorAdapters,
	plan: ExecutionPlan,
): Promise<void> {
	const fromStatus = leg.status as LegStatus;
	if (fromStatus === "pending") {
		await transitionLeg(db, payment.id, leg.id, "pending", "processing");
	}

	if (leg.kind === "settle") {
		await executeSettle(db, payment, leg, planned, adapters, plan);
		return;
	}

	const provider = adapters.getProvider(leg.providerId);
	if (!provider) {
		await transitionLeg(db, payment.id, leg.id, "processing", "failed", "no provider", {
			errorCode: "unsupported",
			errorMessage: `provider ${leg.providerId} not registered`,
		});
		await emitPaymentEvent(db, payment.organizationId, payment.id, "leg.failed", {
			legId: leg.id,
		});
		return;
	}

	// Idempotent replay: already have a ref — poll status, do not execute again.
	if (leg.externalRef) {
		const state = await provider.status(leg.externalRef);
		if (state.status === "succeeded") {
			await transitionLeg(db, payment.id, leg.id, "processing", "succeeded", "replay");
			await emitPaymentEvent(db, payment.organizationId, payment.id, "leg.succeeded", {
				legId: leg.id,
			});
			return;
		}
		if (state.status === "failed") {
			await onProviderLegFailed(
				db,
				payment,
				leg,
				plan,
				state.error?.code ?? "provider_down",
				state.error?.message ?? "failed",
				leg.externalRef,
			);
			return;
		}
		return;
	}

	const amountIn = moneyOf(leg.amountInValue, leg.amountInCurrency);
	const { externalRef } = await provider.execute({
		kind: planned.kind,
		amountIn,
		outCurrency: planned.amountOut.currency,
		endpoint:
			planned.kind === "payout" && plan.payoutEndpoint
				? plan.payoutEndpoint
				: undefined,
		paymentId: payment.id,
		legId: leg.id,
		attempt: leg.attempt,
	});

	await db.leg.update({
		where: { id: leg.id },
		data: { externalRef },
	});

	const state = await provider.status(externalRef);
	if (state.status === "succeeded") {
		await transitionLeg(db, payment.id, leg.id, "processing", "succeeded");
		await emitPaymentEvent(db, payment.organizationId, payment.id, "leg.succeeded", {
			legId: leg.id,
			externalRef,
		});
		return;
	}
	if (state.status === "failed") {
		await onProviderLegFailed(
			db,
			payment,
			leg,
			plan,
			state.error?.code ?? "provider_down",
			state.error?.message ?? "failed",
			externalRef,
		);
	}
}

/**
 * First payout failure after settle: stay `processing`, bump attempt, clear ref (retry).
 * Leg status machine has no failed→pending; final failure then transitions to `failed`.
 */
async function onProviderLegFailed(
	db: Db,
	payment: { id: string; organizationId: string },
	leg: {
		id: string;
		kind: string;
		attempt: number;
		status: string;
	},
	plan: ExecutionPlan,
	errorCode: string,
	errorMessage: string,
	externalRef: string,
): Promise<void> {
	const rows = await db.leg.findMany({
		where: { paymentId: payment.id },
		orderBy: { position: "asc" },
	});
	const action = decideOnFailure({
		failedKind: leg.kind as LegKind,
		legs: legStates(
			rows.map((l) =>
				l.id === leg.id ? { ...l, status: "failed" } : l,
			),
		),
		attemptsOnProvider: leg.attempt,
		untriedProviders: [],
	});

	await emitPaymentEvent(db, payment.organizationId, payment.id, "leg.failed", {
		legId: leg.id,
		externalRef,
		errorCode,
		errorMessage,
		retry: action.action === "retry",
	});

	if (action.action === "retry") {
		await db.leg.update({
			where: { id: leg.id },
			data: {
				attempt: leg.attempt + 1,
				externalRef: null,
				errorCode,
				errorMessage,
				// remain processing for the next execute with attempt+1
			},
		});
		await db.auditRow.create({
			data: {
				id: newId("aud"),
				paymentId: payment.id,
				entity: "leg",
				entityId: leg.id,
				fromStatus: "processing",
				toStatus: "processing",
				reason: `retry scheduled attempt ${leg.attempt + 1}`,
			},
		});
		return;
	}

	await transitionLeg(db, payment.id, leg.id, "processing", "failed", "provider", {
		errorCode,
		errorMessage,
		externalRef,
	});
	void plan;
}

async function executeSettle(
	db: Db,
	payment: { id: string; organizationId: string; lockAttempt: number },
	leg: {
		id: string;
		status: string;
		externalRef: string | null;
		amountInValue: string;
		amountInCurrency: string;
	},
	planned: ExecutionPlan["legs"][number],
	adapters: OrchestratorAdapters,
	plan: ExecutionPlan,
): Promise<void> {
	const feeMode = plan.feeMode as FeeMode;
	// Replay: lock already recorded (externalRef = payoutId).
	if (leg.externalRef) {
		if (plan.claimWaitSettle) {
			// Still waiting for release.
			return;
		}
		const st = await adapters.settlement.status(leg.externalRef);
		if (st.state === "claimed") {
			await transitionLeg(db, payment.id, leg.id, "processing", "succeeded", "replay");
			await emitPaymentEvent(db, payment.organizationId, payment.id, "leg.succeeded", {
				legId: leg.id,
			});
		}
		return;
	}

	const attempt = payment.lockAttempt + 1;
	await db.payment.update({
		where: { id: payment.id },
		data: { lockAttempt: attempt },
	});

	let claimHashHex: string;
	if (plan.claimWaitSettle) {
		const held = claimSecrets.get(payment.id);
		if (!held) throw new Error("claim secret missing for settle lock");
		claimHashHex = held.claimHashHex;
	} else {
		// Direct delivery: backend-held secret (not claim-link UX).
		const secretHex = randomBytes(32).toString("hex");
		claimHashHex = createHash("sha256")
			.update(Buffer.from(secretHex, "hex"))
			.digest("hex");
		claimSecrets.set(payment.id, { secretHex, claimHashHex });
	}

	const amount = moneyOf(leg.amountInValue, leg.amountInCurrency);
	// Cover PayerPays locked = amount + fee as well as RecipientPays locked = amount.
	const bps = await adapters.settlement.feeBps();
	const feePad = {
		amount: ((BigInt(amount.amount) * BigInt(bps)) / 10_000n).toString(),
		currency: amount.currency,
	};
	const fundAmount = {
		amount: (BigInt(amount.amount) + BigInt(feePad.amount)).toString(),
		currency: amount.currency,
	};
	await adapters.settlement.fundVault(adapters.vaultPayer, fundAmount);

	const locked = await adapters.settlement.lock({
		paymentId: payment.id,
		attempt,
		payer: adapters.vaultPayer,
		amount,
		feeMode,
		expiresAt: plan.lockExpiresAt,
		claimHashHex,
	});

	// Persist payoutId for refund/release (schema has no separate payoutId column).
	await db.leg.update({
		where: { id: leg.id },
		data: { externalRef: locked.payoutId },
	});

	await emitPaymentEvent(db, payment.organizationId, payment.id, "payment.onchain", {
		phase: "lock",
		payoutId: locked.payoutId,
		txRef: locked.txRef,
		legId: leg.id,
	});

	if (plan.claimWaitSettle) {
		// Settle stays processing until completeClaimSettle (release).
		return;
	}

	// Fiat / direct: lock succeeds the settle leg; vault payout stays Pending so a later
	// payout failure can SettlementAdapter.refund. Release runs when the payment is paid.
	await transitionLeg(db, payment.id, leg.id, "processing", "succeeded");
	await emitPaymentEvent(db, payment.organizationId, payment.id, "leg.succeeded", {
		legId: leg.id,
	});
	void planned;
}

/** Release a still-pending vault lock once every leg has succeeded (non-claim routes). */
async function releasePendingSettle(
	db: Db,
	paymentId: string,
	adapters: OrchestratorAdapters,
	plan: ExecutionPlan,
): Promise<void> {
	if (plan.claimWaitSettle) return;
	const settle = await db.leg.findFirst({
		where: { paymentId, kind: "settle", status: "succeeded" },
	});
	if (!settle?.externalRef) return;
	const st = await adapters.settlement.status(settle.externalRef);
	if (st.state !== "pending") return;
	const held = claimSecrets.get(paymentId);
	if (!held) return;
	const released = await adapters.settlement.release({
		payoutId: settle.externalRef,
		secretHex: held.secretHex,
		destination: plan.claimDestination ?? adapters.vaultPayer,
	});
	const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
	await emitPaymentEvent(db, payment.organizationId, paymentId, "payment.onchain", {
		phase: "release",
		payoutId: settle.externalRef,
		txRef: released.txRef,
		legId: settle.id,
	});
	claimSecrets.delete(paymentId);
}

/**
 * Completes a claim-wait settle: release vault funds, mark settle succeeded, payment paid.
 */
export async function completeClaimSettle(
	db: Db,
	paymentId: string,
	adapters: OrchestratorAdapters,
	opts: { secretHex: string; destination: string },
): Promise<{ status: PaymentStatus }> {
	const payment = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
		include: { legs: { orderBy: { position: "asc" } }, claimLink: true },
	});
	if (payment.status !== "processing") {
		throw new Error(`completeClaimSettle requires processing, got ${payment.status}`);
	}
	const settle = payment.legs.find((l) => l.kind === "settle");
	if (!settle || settle.status !== "processing" || !settle.externalRef) {
		throw new Error("settle leg is not waiting for release");
	}

	const held = claimSecrets.get(paymentId);
	if (held && held.secretHex !== opts.secretHex) {
		throw new Error("claim secret mismatch");
	}

	const released = await adapters.settlement.release({
		payoutId: settle.externalRef,
		secretHex: opts.secretHex,
		destination: opts.destination,
	});

	await emitPaymentEvent(db, payment.organizationId, paymentId, "payment.onchain", {
		phase: "release",
		payoutId: settle.externalRef,
		txRef: released.txRef,
		legId: settle.id,
	});
	await transitionLeg(db, paymentId, settle.id, "processing", "succeeded");
	await emitPaymentEvent(db, payment.organizationId, paymentId, "leg.succeeded", {
		legId: settle.id,
	});

	if (payment.claimLink && payment.claimLink.status === "open") {
		await db.claimLink.update({
			where: { paymentId },
			data: { status: "accepted" },
		});
		await emitPaymentEvent(db, payment.organizationId, paymentId, "claim.accepted");
	}

	claimSecrets.delete(paymentId);

	const legs = await db.leg.findMany({
		where: { paymentId },
		orderBy: { position: "asc" },
	});
	if (isPaid(legStates(legs))) {
		await transitionPayment(
			db,
			paymentId,
			payment.organizationId,
			"processing",
			"paid",
		);
	}

	const after = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
	return { status: after.status as PaymentStatus };
}

async function handleLegFailure(
	db: Db,
	paymentId: string,
	failedLegId: string,
	adapters: OrchestratorAdapters,
	_plan: ExecutionPlan,
): Promise<void> {
	const payment = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
		include: { legs: { orderBy: { position: "asc" } } },
	});
	const failed = payment.legs.find((l) => l.id === failedLegId)!;
	const action = decideOnFailure({
		failedKind: failed.kind as LegKind,
		legs: legStates(payment.legs),
		attemptsOnProvider: failed.attempt,
		untriedProviders: [], // MVP: no reroute (ARCHITECTURE §7)
	});

	// Retry is handled inside onProviderLegFailed while the leg is still processing.
	if (action.action === "retry") {
		await db.leg.update({
			where: { id: failed.id },
			data: {
				status: "processing",
				attempt: failed.attempt + 1,
				externalRef: null,
			},
		});
		return;
	}

	await transitionPayment(
		db,
		paymentId,
		payment.organizationId,
		"processing",
		"refunding",
		action.action,
	);

	if (action.action === "refund_vault") {
		const settle = payment.legs.find(
			(l) => l.kind === "settle" && l.externalRef,
		);
		if (settle?.externalRef) {
			await adapters.settlement.refund(settle.externalRef);
			await emitPaymentEvent(db, payment.organizationId, paymentId, "payment.onchain", {
				phase: "refund",
				payoutId: settle.externalRef,
			});
		}
	}

	// Reverse earlier succeeded collect/convert legs (newest first).
	const reversible = [...payment.legs]
		.filter(
			(l) =>
				(l.kind === "collect" || l.kind === "convert") &&
				l.status === "succeeded" &&
				l.externalRef,
		)
		.reverse();

	for (const leg of reversible) {
		const provider = adapters.getProvider(leg.providerId);
		if (!provider || !leg.externalRef) continue;
		await transitionLeg(db, paymentId, leg.id, "succeeded", "reversing");
		await provider.reverse(leg.externalRef);
		await transitionLeg(db, paymentId, leg.id, "reversing", "reversed");
	}

	await transitionPayment(
		db,
		paymentId,
		payment.organizationId,
		"refunding",
		"refunded",
	);
}

export async function getPaymentView(db: Db, paymentId: string) {
	return paymentSnapshot(db, paymentId);
}

export { claimSecrets as _claimSecretsForTests };
