import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { isSolanaSettleRail, type PaymentStatus } from "@flexipay/domain";
import type { Db } from "../db.ts";
import { newId } from "../ids.ts";
import {
	getSolanaRefundRpc,
	prepareTreasuryRefund,
	refundSignatureStatus,
	sendPreparedTreasuryRefund,
	treasuryRefundSigner,
} from "../solana/treasury-refund.ts";
import { emitPaymentEvent, transitionLeg, transitionPayment } from "./persist.ts";
import type { OrchestratorAdapters } from "./types.ts";

export type SolanaRefundResult =
	| { required: false }
	| {
			required: true;
			status: "pending" | "confirmed";
			refundTxRef?: string;
			error?: string;
	  };

const CONFIRM_POLLS = 5;
const CONFIRM_DELAY_MS = 500;

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * CCR-37: a Solana settle that landed in the FlexiPay treasury, followed by a partner failure,
 * must return the same mint and exact transferred amount to the original payer. This is separate
 * from the Stellar/mock vault refund: a Solana settle has `releaseTxRef`, never `externalRef`.
 */
export async function refundSolanaSettleIfOwed(
	db: Db,
	paymentId: string,
): Promise<SolanaRefundResult> {
	const payment = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
		include: { legs: { orderBy: { position: "asc" } } },
	});
	if (payment.status !== "refunding") return { required: false };

	const settle = payment.legs.find((leg) => leg.kind === "settle");
	if (
		!settle ||
		settle.status !== "succeeded" ||
		!isSolanaSettleRail(settle.rail)
	) {
		return { required: false };
	}
	// A claim-link Solana transfer went to the recipient, not the settle treasury. Only a direct
	// treasury settlement has FlexiPay funds to return.
	if (payment.delivery !== "direct") return { required: false };
	// A succeeded treasury settle without its evidence is an inconsistent row. Never fall through
	// to the legacy path, which would mark the payment refunded without moving any money.
	if (!settle.releaseTxRef) {
		throw new Error(
			"succeeded Solana settle has no release transaction evidence",
		);
	}

	const configuredTreasury =
		process.env.FP_SOLANA_SETTLE_TREASURY?.trim() ?? "";
	const treasury = payment.solanaSettleDestination;
	if (!treasury || !configuredTreasury || treasury !== configuredTreasury) {
		throw new Error(
			"stored Solana settle treasury is missing or does not match FP_SOLANA_SETTLE_TREASURY",
		);
	}
	if (
		!payment.solanaPayer ||
		!payment.solanaSettleMint ||
		!payment.solanaSettleAmount ||
		payment.solanaSettleDecimals === null
	) {
		throw new Error(
			"Solana settle refund data is incomplete (payer, mint, amount or decimals)",
		);
	}

	let refund = await db.solanaRefund.upsert({
		where: { paymentId },
		create: {
			id: newId("srf"),
			paymentId,
			payer: payment.solanaPayer,
			mint: payment.solanaSettleMint,
			decimals: payment.solanaSettleDecimals,
			amountValue: payment.solanaSettleAmount,
			treasury,
			status: "pending",
		},
		update: {},
	});
	if (refund.status === "confirmed" && refund.signature) {
		return {
			required: true,
			status: "confirmed",
			refundTxRef: refund.signature,
		};
	}

	try {
		const signer = treasuryRefundSigner(refund.treasury);
		const rpc = getSolanaRefundRpc();
		const reference = new PublicKey(
			createHash("sha256").update(`ccr37:${paymentId}`).digest(),
		).toBase58();
		const prepared = async () => {
			const next = await prepareTreasuryRefund({
				rpc,
				signer,
				payer: refund.payer,
				mint: refund.mint,
				amountMinor: BigInt(refund.amountValue),
				decimals: refund.decimals,
				reference,
			});
			refund = await db.solanaRefund.update({
				where: { id: refund.id },
				data: {
					signature: next.signature,
					signedTx: next.signedTransaction,
					lastValidBlockHeight: next.lastValidBlockHeight,
					attempts: { increment: 1 },
					status: "submitted",
					lastError: null,
				},
			});
			return next;
		};

		if (!refund.signature || !refund.signedTx) {
			await prepared();
		} else {
			const state = await refundSignatureStatus(rpc, refund.signature);
			if (state === "confirmed") {
				return await markConfirmed(db, payment, settle.id, refund.id);
			}
			const height = await rpc.getBlockHeight();
			const expired =
				refund.lastValidBlockHeight !== null &&
				height > refund.lastValidBlockHeight;
			if (state === "failed") {
				if (!expired) {
					throw new Error("Solana refund transaction failed on-chain");
				}
				await prepared();
			} else if (expired) {
				// The old signature can no longer land; a fresh blockhash is safe.
				await prepared();
			}
		}

		if (!refund.signedTx) {
			throw new Error("Solana refund signed transaction is missing");
		}
		try {
			await sendPreparedTreasuryRefund(rpc, refund.signedTx);
		} catch (cause) {
			// The send may have landed before the RPC answered. Never send again before checking.
			const state = await refundSignatureStatus(rpc, refund.signature!);
			if (state === "confirmed") {
				return await markConfirmed(db, payment, settle.id, refund.id);
			}
			throw cause;
		}

		for (let attempt = 0; attempt < CONFIRM_POLLS; attempt += 1) {
			const state = await refundSignatureStatus(rpc, refund.signature!);
			if (state === "confirmed") {
				return await markConfirmed(db, payment, settle.id, refund.id);
			}
			if (state === "failed") {
				throw new Error("Solana refund transaction failed on-chain");
			}
			if (attempt < CONFIRM_POLLS - 1) await sleep(CONFIRM_DELAY_MS);
		}

		await db.solanaRefund.update({
			where: { id: refund.id },
			data: {
				status: "submitted",
				lastError: "refund submitted; waiting for on-chain confirmation",
			},
		});
		return { required: true, status: "pending" };
	} catch (cause) {
		const message =
			cause instanceof Error ? cause.message : "Solana refund failed";
		await db.solanaRefund.update({
			where: { id: refund.id },
			data: { lastError: message },
		});
		return { required: true, status: "pending", error: message };
	}
}

async function markConfirmed(
	db: Db,
	payment: { id: string; organizationId: string },
	settleLegId: string,
	refundId: string,
): Promise<SolanaRefundResult> {
	const current = await db.solanaRefund.findUniqueOrThrow({
		where: { id: refundId },
	});
	if (!current.signature) {
		throw new Error("confirmed Solana refund has no signature");
	}
	if (current.status !== "confirmed") {
		await db.solanaRefund.update({
			where: { id: refundId },
			data: {
				status: "confirmed",
				confirmedAt: current.confirmedAt ?? new Date(),
				lastError: null,
			},
		});
		// The signature is the durable proof; an event failure must not turn a confirmed refund
		// into another send attempt.
		await emitPaymentEvent(
			db,
			payment.organizationId,
			payment.id,
			"payment.onchain",
			{
				phase: "refund",
				network: "solana",
				refundTxRef: current.signature,
				payer: current.payer,
				mint: current.mint,
				amount: current.amountValue,
				legId: settleLegId,
			},
		).catch(() => undefined);
	}
	return {
		required: true,
		status: "confirmed",
		refundTxRef: current.signature,
	};
}

/**
 * After the treasury transfer is confirmed, reverse reversible collect/convert legs and move the
 * payment to `refunded`. The transition is deliberately last: `refunded` means money is back.
 */
export async function reverseAndCompleteSolanaRefund(
	db: Db,
	paymentId: string,
	adapters: OrchestratorAdapters,
): Promise<{ status: PaymentStatus }> {
	const payment = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
		include: { legs: { orderBy: { position: "asc" } } },
	});
	if (payment.status !== "refunding") {
		return { status: payment.status as PaymentStatus };
	}

	const reversible = [...payment.legs]
		.filter(
			(leg) =>
				(leg.kind === "collect" || leg.kind === "convert") &&
				leg.status === "succeeded" &&
				leg.externalRef,
		)
		.reverse();
	for (const leg of reversible) {
		const provider = adapters.getProvider(leg.providerId);
		if (!provider || !leg.externalRef) continue;
		try {
			await transitionLeg(db, paymentId, leg.id, "succeeded", "reversing");
			await provider.reverse(leg.externalRef);
			await transitionLeg(db, paymentId, leg.id, "reversing", "reversed");
		} catch (cause) {
			await transitionPayment(
				db,
				paymentId,
				payment.organizationId,
				"refunding",
				"failed",
				cause instanceof Error ? cause.message : "reverse failed",
			);
			return { status: "failed" };
		}
	}

	await transitionPayment(
		db,
		paymentId,
		payment.organizationId,
		"refunding",
		"refunded",
	);
	return { status: "refunded" };
}

/** Called by the provider poller when a refund has not reached `refunded` yet. */
export async function resumeSolanaRefund(
	db: Db,
	paymentId: string,
	adapters: OrchestratorAdapters,
): Promise<{ status: PaymentStatus }> {
	const payment = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
	});
	if (payment.status !== "refunding") {
		return { status: payment.status as PaymentStatus };
	}
	const refund = await refundSolanaSettleIfOwed(db, paymentId);
	if (!refund.required || refund.status !== "confirmed") {
		return { status: "refunding" };
	}
	return reverseAndCompleteSolanaRefund(db, paymentId, adapters);
}
