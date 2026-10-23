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
import { newId } from "../ids.ts";
import {
	claimSealKeyFromEnv,
	sealClaimSecret,
	unsealClaimSecret,
} from "./claim-seal.ts";
import { isClaimWaitRoute } from "./create.ts";
import {
	emitPaymentEvent,
	transitionLeg,
	transitionPayment,
} from "./persist.ts";
import type { OrchestratorAdapters } from "./types.ts";

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

function sealKey(adapters: OrchestratorAdapters): Buffer {
	return adapters.claimSealKey ?? claimSealKeyFromEnv();
}

async function loadRuntime(
	db: Db,
	paymentId: string,
	claimEndpointId?: string,
): Promise<{
	payment: {
		id: string;
		organizationId: string;
		status: string;
		lockAttempt: number;
		delivery: string;
	};
	legs: Array<{
		id: string;
		position: number;
		kind: string;
		rail: string;
		providerId: string;
		status: string;
		attempt: number;
		externalRef: string | null;
		lockTxRef: string | null;
		releaseTxRef: string | null;
		amountInValue: string;
		amountInCurrency: string;
		amountOutValue: string;
		amountOutCurrency: string;
		errorCode: string | null;
		errorMessage: string | null;
	}>;
	feeMode: FeeMode | null;
	/** Frozen vault fee from Quote.fees.flexiPayFee (CCR-13). */
	quotedFlexiPayFee: Money | null;
	claimWaitSettle: boolean;
	/** ClaimLink status, null when the payment has no claim link row. */
	claimStatus: string | null;
	lockExpiresAt: Date;
	payoutEndpoint:
		| {
				endpointId: string;
				type: "bank_account" | "ewallet" | "crypto_wallet" | "crypto_custodial";
				country: string;
				currency: string;
		  }
		| undefined;
}> {
	const payment = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
		include: {
			legs: { orderBy: { position: "asc" } },
			quote: true,
			claimLink: true,
		},
	});
	const dest = payment.quote.destination as {
		type: string;
		country: string;
		currency: string;
	};
	const feeMode = (payment.quote.feeMode as FeeMode | null) ?? null;
	const claimWaitSettle = isClaimWaitRoute(payment.legs);
	if (payment.legs.some((l) => l.kind === "settle") && feeMode === null) {
		throw new Error("quote.feeMode missing for settle route (CCR-13)");
	}
	const fees = payment.quote.fees as {
		flexiPayFee?: { amount: string; currency: string };
	};
	const quotedFlexiPayFee =
		fees.flexiPayFee?.amount !== undefined
			? moneyOf(fees.flexiPayFee.amount, fees.flexiPayFee.currency)
			: null;
	const payoutEndpoint =
		dest.type === "bank_account" || dest.type === "ewallet"
			? {
					endpointId: claimEndpointId ?? "quote_dest",
					type: dest.type as "bank_account" | "ewallet",
					country: dest.country,
					currency: dest.currency,
				}
			: undefined;
	return {
		payment,
		legs: payment.legs,
		feeMode,
		quotedFlexiPayFee,
		claimWaitSettle,
		claimStatus: payment.claimLink?.status ?? null,
		lockExpiresAt: payment.claimLink?.expiresAt ?? payment.quote.validUntil,
		payoutEndpoint,
	};
}

export interface FundResult {
	paymentId: string;
	status: PaymentStatus;
}

/**
 * Marks funded and runs legs in order (ARCHITECTURE §1a / §7).
 * Amounts and feeMode come from persisted Quote/Leg rows (CCR-13) — no re-price.
 * Replay-safe: succeeded refs are not re-executed.
 */
export async function fundAndRun(
	db: Db,
	paymentId: string,
	adapters: OrchestratorAdapters,
): Promise<FundResult> {
	const payment = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
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

	await runPendingLegs(db, paymentId, adapters);

	const after = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
	return { paymentId, status: after.status as PaymentStatus };
}

/**
 * Fiat claim link (ARCHITECTURE §7): collect, convert and settle run at funding; the payout leg
 * stays `pending` until the recipient accepts and picks the endpoint.
 */
export async function continueAfterClaimAccept(
	db: Db,
	paymentId: string,
	adapters: OrchestratorAdapters,
	claimEndpointId: string,
): Promise<{ status: PaymentStatus }> {
	await runPendingLegs(db, paymentId, adapters, claimEndpointId);
	const after = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
	return { status: after.status as PaymentStatus };
}

async function runPendingLegs(
	db: Db,
	paymentId: string,
	adapters: OrchestratorAdapters,
	claimEndpointId?: string,
): Promise<void> {
	for (;;) {
		const rt = await loadRuntime(db, paymentId, claimEndpointId);
		if (rt.payment.status !== "processing") return;

		const states = legStates(rt.legs);
		if (isPaid(states)) {
			await releasePendingSettle(db, paymentId, adapters, rt);
			await transitionPayment(
				db,
				paymentId,
				rt.payment.organizationId,
				"processing",
				"paid",
			);
			return;
		}

		let idx = nextLegIndex(states);
		if (idx === undefined) {
			const processing = rt.legs.find((l) => l.status === "processing");
			const failed = rt.legs.find((l) => l.status === "failed");
			if (
				processing?.kind === "settle" &&
				rt.claimWaitSettle &&
				processing.externalRef
			) {
				return;
			}
			if (processing) {
				idx = processing.position;
			} else if (failed) {
				await handleLegFailure(db, paymentId, failed.id, adapters);
				continue;
			} else {
				return;
			}
		}

		const leg = rt.legs[idx]!;
		// Fiat claim link: the payout waits for the recipient (ARCHITECTURE §7). The payment stays
		// `processing` and the payout `pending` until accept supplies the endpoint.
		if (
			leg.kind === "payout" &&
			leg.status === "pending" &&
			rt.payment.delivery === "claim_link" &&
			rt.claimStatus !== "accepted"
		) {
			return;
		}
		await executeLeg(db, rt, leg, adapters);

		const refreshed = await db.leg.findUniqueOrThrow({ where: { id: leg.id } });
		if (refreshed.status === "failed") {
			await handleLegFailure(db, paymentId, leg.id, adapters);
		}
	}
}

async function executeLeg(
	db: Db,
	rt: Awaited<ReturnType<typeof loadRuntime>>,
	leg: Awaited<ReturnType<typeof loadRuntime>>["legs"][number],
	adapters: OrchestratorAdapters,
): Promise<void> {
	const payment = rt.payment;
	if (leg.status === "pending") {
		await transitionLeg(db, payment.id, leg.id, "pending", "processing");
	}

	if (leg.kind === "settle") {
		await executeSettle(db, rt, leg, adapters);
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
		kind: leg.kind as LegKind,
		amountIn,
		outCurrency: leg.amountOutCurrency,
		endpoint:
			leg.kind === "payout" && rt.payoutEndpoint
				? rt.payoutEndpoint
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
			state.error?.code ?? "provider_down",
			state.error?.message ?? "failed",
			externalRef,
		);
	}
}

/** CCR-14: keep `processing`, bump attempt, clear refs; audit attempt before/after. */
async function onProviderLegFailed(
	db: Db,
	payment: { id: string; organizationId: string },
	leg: { id: string; kind: string; attempt: number; status: string },
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
			rows.map((l) => (l.id === leg.id ? { ...l, status: "failed" } : l)),
		),
		attemptsOnProvider: leg.attempt,
		untriedProviders: [],
	});

	const attemptBefore = leg.attempt;
	await emitPaymentEvent(db, payment.organizationId, payment.id, "leg.failed", {
		legId: leg.id,
		externalRef,
		errorCode,
		errorMessage,
		retry: action.action === "retry",
		attemptBefore,
		attemptAfter: action.action === "retry" ? attemptBefore + 1 : attemptBefore,
	});

	if (action.action === "retry") {
		const attemptAfter = attemptBefore + 1;
		await db.leg.update({
			where: { id: leg.id },
			data: {
				attempt: attemptAfter,
				externalRef: null,
				lockTxRef: null,
				releaseTxRef: null,
				errorCode,
				errorMessage,
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
				reason: `CCR-14 retry attempt ${attemptBefore} -> ${attemptAfter}`,
			},
		});
		return;
	}

	await transitionLeg(db, payment.id, leg.id, "processing", "failed", "provider", {
		errorCode,
		errorMessage,
		externalRef,
	});
}

async function ensureClaimSeal(
	db: Db,
	paymentId: string,
	organizationId: string,
	delivery: string,
	lockExpiresAt: Date,
	adapters: OrchestratorAdapters,
): Promise<string> {
	const key = sealKey(adapters);
	let link = await db.claimLink.findUnique({ where: { paymentId } });
	if (link?.vaultClaimHashHex && link.secretSealed && link.secretSealedNonce) {
		return link.vaultClaimHashHex;
	}

	const secretHex = randomBytes(32).toString("hex");
	const claimHashHex = createHash("sha256")
		.update(Buffer.from(secretHex, "hex"))
		.digest("hex");
	const { sealed, nonce } = sealClaimSecret(secretHex, key);

	const sealedBytes = Uint8Array.from(sealed);
	const nonceBytes = Uint8Array.from(nonce);
	if (!link) {
		// Direct delivery still needs durable seal for release after restart (CCR-11).
		await db.claimLink.create({
			data: {
				paymentId,
				tokenHash: sha256HexOpaque(paymentId),
				vaultClaimHashHex: claimHashHex,
				secretSealed: sealedBytes,
				secretSealedNonce: nonceBytes,
				expiresAt: lockExpiresAt,
				status: delivery === "claim_link" ? "open" : "accepted",
			},
		});
	} else {
		await db.claimLink.update({
			where: { paymentId },
			data: {
				vaultClaimHashHex: claimHashHex,
				secretSealed: sealedBytes,
				secretSealedNonce: nonceBytes,
			},
		});
	}
	void organizationId;
	return claimHashHex;
}

function sha256HexOpaque(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}

async function loadUnsealedSecret(
	db: Db,
	paymentId: string,
	adapters: OrchestratorAdapters,
): Promise<string> {
	const link = await db.claimLink.findUniqueOrThrow({ where: { paymentId } });
	if (!link.secretSealed || !link.secretSealedNonce) {
		throw new Error("claim secret seal missing (CCR-11)");
	}
	return unsealClaimSecret(
		Buffer.from(link.secretSealed),
		Buffer.from(link.secretSealedNonce),
		sealKey(adapters),
	);
}

async function executeSettle(
	db: Db,
	rt: Awaited<ReturnType<typeof loadRuntime>>,
	leg: Awaited<ReturnType<typeof loadRuntime>>["legs"][number],
	adapters: OrchestratorAdapters,
): Promise<void> {
	const payment = rt.payment;
	const feeMode = rt.feeMode as FeeMode;

	// Replay: externalRef is vault payoutId (CCR-12) — never re-lock / re-fund.
	if (leg.externalRef) {
		await resumeAfterSettleLock(db, rt, leg, adapters, leg.externalRef);
		return;
	}

	// Lost lock response: recover payoutId for the current attempt (RULES payout_by_external).
	if (payment.lockAttempt > 0) {
		const recovered = await adapters.settlement.findLock(
			adapters.vaultPayer,
			payment.id,
			payment.lockAttempt,
		);
		if (recovered) {
			await db.leg.update({
				where: { id: leg.id },
				data: { externalRef: recovered },
			});
			await resumeAfterSettleLock(db, rt, leg, adapters, recovered);
			return;
		}
	}

	const attempt = payment.lockAttempt + 1;
	await db.payment.update({
		where: { id: payment.id },
		data: { lockAttempt: attempt },
	});

	// Crash window after lockAttempt bump: findLock before creating a second lock.
	{
		const recovered = await adapters.settlement.findLock(
			adapters.vaultPayer,
			payment.id,
			attempt,
		);
		if (recovered) {
			await db.leg.update({
				where: { id: leg.id },
				data: { externalRef: recovered },
			});
			await resumeAfterSettleLock(db, rt, leg, adapters, recovered);
			return;
		}
	}

	const claimHashHex = await ensureClaimSeal(
		db,
		payment.id,
		payment.organizationId,
		payment.delivery,
		rt.lockExpiresAt,
		adapters,
	);

	// CCR-13: lock amount = settle leg amountIn (quoted P); feeMode from quote.
	const amount = moneyOf(leg.amountInValue, leg.amountInCurrency);
	const quotedFee = rt.quotedFlexiPayFee;
	if (!quotedFee || quotedFee.currency !== amount.currency) {
		throw new Error(
			"quote.fees.flexiPayFee missing or currency mismatch for settle lock (CCR-13)",
		);
	}
	// RecipientPays: vault locks P (fee from principal). PayerPays: locks P+f(P).
	// Fund only what lock will debit — use frozen quoted fee, never a live-bps pad.
	const fundAmount =
		feeMode === "PayerPays"
			? {
					amount: (
						BigInt(amount.amount) + BigInt(quotedFee.amount)
					).toString(),
					currency: amount.currency,
				}
			: amount;
	await adapters.settlement.fundVault(adapters.vaultPayer, fundAmount);

	const locked = await adapters.settlement.lock({
		paymentId: payment.id,
		attempt,
		payer: adapters.vaultPayer,
		amount,
		feeMode,
		expiresAt: rt.lockExpiresAt,
		claimHashHex,
	});

	// CCR-12: persist payoutId + lockTxRef immediately so a fee-drift throw cannot orphan the lock.
	await db.leg.update({
		where: { id: leg.id },
		data: {
			externalRef: locked.payoutId,
			lockTxRef: locked.txRef,
		},
	});

	await emitPaymentEvent(db, payment.organizationId, payment.id, "payment.onchain", {
		phase: "lock",
		payoutId: locked.payoutId,
		lockTxRef: locked.txRef,
		legId: leg.id,
	});

	if (
		locked.fee.amount !== quotedFee.amount ||
		locked.fee.currency !== quotedFee.currency
	) {
		// Do not accept drifted fee or mark paid. Refund/recovery of the pending lock is not
		// contracted beyond CCR-12 replay (keep refs; never re-lock) — leave payout pending.
		throw new Error(
			`lock fee drift: locked.fee=${locked.fee.amount} ${locked.fee.currency} != quoted flexiPayFee=${quotedFee.amount} ${quotedFee.currency} (CCR-13)`,
		);
	}

	if (rt.claimWaitSettle) return;

	await transitionLeg(db, payment.id, leg.id, "processing", "succeeded");
	await emitPaymentEvent(db, payment.organizationId, payment.id, "leg.succeeded", {
		legId: leg.id,
	});
}

/** After a durable settle lock ref exists: never re-lock; succeed only if already claimed. */
async function resumeAfterSettleLock(
	db: Db,
	rt: Awaited<ReturnType<typeof loadRuntime>>,
	leg: Awaited<ReturnType<typeof loadRuntime>>["legs"][number],
	adapters: OrchestratorAdapters,
	payoutId: string,
): Promise<void> {
	if (rt.claimWaitSettle) return;
	const st = await adapters.settlement.status(payoutId);
	if (st.state === "claimed") {
		await transitionLeg(
			db,
			rt.payment.id,
			leg.id,
			"processing",
			"succeeded",
			"replay",
		);
		await emitPaymentEvent(
			db,
			rt.payment.organizationId,
			rt.payment.id,
			"leg.succeeded",
			{ legId: leg.id },
		);
	}
}

async function releasePendingSettle(
	db: Db,
	paymentId: string,
	adapters: OrchestratorAdapters,
	rt: Awaited<ReturnType<typeof loadRuntime>>,
): Promise<void> {
	if (rt.claimWaitSettle) return;
	const settle = await db.leg.findFirst({
		where: { paymentId, kind: "settle", status: "succeeded" },
	});
	if (!settle?.externalRef) return;
	const st = await adapters.settlement.status(settle.externalRef);
	if (st.state !== "pending") return;

	const secretHex = await loadUnsealedSecret(db, paymentId, adapters);
	const destination =
		adapters.defaultClaimDestination ?? adapters.vaultPayer;
	const released = await adapters.settlement.release({
		payoutId: settle.externalRef,
		secretHex,
		destination,
	});

	await db.leg.update({
		where: { id: settle.id },
		data: { releaseTxRef: released.txRef },
	});

	const payment = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
	await emitPaymentEvent(db, payment.organizationId, paymentId, "payment.onchain", {
		phase: "release",
		payoutId: settle.externalRef,
		releaseTxRef: released.txRef,
		legId: settle.id,
	});
}

/**
 * Claim-wait settle: release using durable sealed secret (CCR-11).
 * Restart-safe: does not require an in-process Map.
 */
export async function completeClaimSettle(
	db: Db,
	paymentId: string,
	adapters: OrchestratorAdapters,
	opts: { destination: string; secretHex?: string },
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
	if (settle.releaseTxRef) {
		// Idempotent: already released.
		const after = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
		return { status: after.status as PaymentStatus };
	}

	const sealedSecret = await loadUnsealedSecret(db, paymentId, adapters);
	if (opts.secretHex && opts.secretHex !== sealedSecret) {
		throw new Error("claim secret mismatch");
	}

	const released = await adapters.settlement.release({
		payoutId: settle.externalRef,
		secretHex: sealedSecret,
		destination: opts.destination,
	});

	await db.leg.update({
		where: { id: settle.id },
		data: { releaseTxRef: released.txRef },
	});

	await emitPaymentEvent(db, payment.organizationId, paymentId, "payment.onchain", {
		phase: "release",
		payoutId: settle.externalRef,
		releaseTxRef: released.txRef,
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
		untriedProviders: [],
	});

	// CCR-14 retry is applied in onProviderLegFailed while status stays `processing`.
	// Never failed→processing here (no SM edge / no undocumented bypass).
	if (action.action === "retry") {
		throw new Error(
			"CCR-14 retry must be handled while leg is still processing (attempt bump)",
		);
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
			try {
				const refunded = await adapters.settlement.refund(settle.externalRef);
				await db.leg.update({
					where: { id: settle.id },
					data: { releaseTxRef: refunded.txRef },
				});
				await emitPaymentEvent(
					db,
					payment.organizationId,
					paymentId,
					"payment.onchain",
					{
						phase: "refund",
						payoutId: settle.externalRef,
						releaseTxRef: refunded.txRef,
					},
				);
			} catch (e) {
				await transitionPayment(
					db,
					paymentId,
					payment.organizationId,
					"refunding",
					"failed",
					e instanceof Error ? e.message : "refund failed",
				);
				return;
			}
		}
	}

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
		try {
			await transitionLeg(db, paymentId, leg.id, "succeeded", "reversing");
			await provider.reverse(leg.externalRef);
			await transitionLeg(db, paymentId, leg.id, "reversing", "reversed");
		} catch (e) {
			await transitionPayment(
				db,
				paymentId,
				payment.organizationId,
				"refunding",
				"failed",
				e instanceof Error ? e.message : "reverse failed",
			);
			return;
		}
	}

	await transitionPayment(
		db,
		paymentId,
		payment.organizationId,
		"refunding",
		"refunded",
	);
}

export async function cancelPayment(
	db: Db,
	paymentId: string,
): Promise<{ status: PaymentStatus }> {
	const payment = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
	});
	if (payment.status !== "awaiting_funding" && payment.status !== "funded") {
		throw new Error(`cannot cancel payment in status ${payment.status}`);
	}
	const from = payment.status as PaymentStatus;
	await transitionPayment(
		db,
		paymentId,
		payment.organizationId,
		from,
		"cancelled",
	);
	return { status: "cancelled" };
}

export { getPaymentView } from "./persist.ts";
