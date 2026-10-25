import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import {
	AnchorClientError,
	buildAndSignClassicPaymentWithMemo,
	loadAnchorEventEnv,
	submitSignedClassicPayment,
	type AnchorPaymentExpectation,
	type ClassicPaymentHorizon,
	type ClassicPaymentResult,
	type SignedClassicPayment,
} from "@flexipay/adapter-stellar";
import type { Transaction } from "@stellar/stellar-sdk";
import type { Db } from "../db.ts";
import { ApiError } from "../errors.ts";
import { sealBytes, unsealBytes } from "../orchestrator/claim-seal.ts";
import type { ApiRuntime } from "../runtime.ts";
import type { AnchorWithdrawStatusResult } from "./claim-anchor-gateway.ts";

/**
 * CCR-22 /pay:
 * - Only the DB-reservation winner may submit.
 * - Public replay reconciles by retained hash only (Horizon first):
 *   proven success → 200; proven failure → 409; unresolved → 202.
 * - Retained envelope does NOT authorise resubmit.
 * - New payment only when SEP-24 status is pending_user_transfer_start.
 */

const DEFAULT_HORIZON = "https://horizon-testnet.stellar.org";

export type AnchorPayOutcome =
	| {
			httpStatus: 200;
			body: {
				status: "submitted";
				anchorTxId: string;
				anchorPaymentTxHash: string;
			};
	  }
	| {
			httpStatus: 202;
			body: {
				status: "pending";
				anchorTxId: string;
				pendingTxHash: string;
			};
	  };

export type ClassicTxLookupResult =
	| { found: false }
	| { found: true; successful: boolean };

function mapPayError(e: unknown): never {
	if (e instanceof ApiError) throw e;
	if (e instanceof AnchorClientError) {
		throw new ApiError(502, "classic_payment_failed", e.message);
	}
	const msg = e instanceof Error ? e.message : "classic payment failed";
	throw new ApiError(502, "classic_payment_failed", msg);
}

function expectationFromStatus(
	view: AnchorWithdrawStatusResult,
	asset: AnchorPaymentExpectation["asset"],
): AnchorPaymentExpectation {
	const destination = view.withdrawAnchorAccount;
	const memo = view.withdrawMemo;
	const amount = view.amountIn;
	if (!destination || !memo || !amount) {
		throw new ApiError(
			409,
			"invalid_state",
			"SEP-24 withdraw is not ready for classic payment (missing memo/account/amount)",
		);
	}
	return {
		asset,
		amount,
		destination,
		memo,
		memoType: view.withdrawMemoType,
	};
}

type PayLinkRow = {
	anchorPayPendingTxHash: string | null;
	anchorPayPendingSealed: Uint8Array | Buffer | null;
	anchorPayPendingSealedNonce: Uint8Array | Buffer | null;
	anchorPayMinTime: number | null;
	anchorPayMaxTime: number | null;
	anchorPayStatus: string | null;
	anchorPaymentTxHash: string | null;
};

/** Decode payment destination + amount from a signed classic envelope (no placeholders). */
export function paymentFieldsFromSignedTx(tx: Transaction): {
	destination: string;
	amount: string;
} {
	const op = tx.operations.find((o) => o.type === "payment");
	if (!op || op.type !== "payment") {
		throw new ApiError(
			502,
			"classic_payment_failed",
			"retained envelope has no payment operation",
		);
	}
	const destination = (op as { destination?: string }).destination;
	const amount = (op as { amount?: string }).amount;
	if (!destination || !amount) {
		throw new ApiError(
			502,
			"classic_payment_failed",
			"retained envelope payment fields incomplete",
		);
	}
	return { destination, amount };
}

export async function defaultLookupClassicTxByHash(
	hash: string,
	horizonUrl = DEFAULT_HORIZON,
): Promise<ClassicTxLookupResult> {
	try {
		const res = await fetch(`${horizonUrl.replace(/\/$/, "")}/transactions/${hash}`);
		if (res.status === 404) return { found: false };
		if (!res.ok) return { found: false };
		const body = (await res.json()) as { successful?: boolean };
		return { found: true, successful: Boolean(body.successful) };
	} catch {
		// Network / ambiguous — treat as unresolved (caller returns 202).
		return { found: false };
	}
}

function isDefinitiveHorizonReject(e: unknown): boolean {
	if (!e || typeof e !== "object") return false;
	const status = (e as { response?: { status?: number } }).response?.status;
	if (status === 400) return true;
	const msg = e instanceof Error ? e.message : String(e);
	return (
		/\btx_failed\b/i.test(msg) ||
		/\bop_underfunded\b/i.test(msg) ||
		/\bop_no_destination\b/i.test(msg) ||
		/\bhorizon.*reject/i.test(msg)
	);
}

/**
 * Reconcile a retained hash against Horizon (before local expiry).
 * Envelope presence alone never triggers resubmit.
 */
async function reconcileByRetainedHash(opts: {
	db: Db;
	runtime: ApiRuntime;
	paymentId: string;
	anchorTxId: string;
	hash: string;
	link: PayLinkRow;
}): Promise<AnchorPayOutcome> {
	const { db, runtime, paymentId, anchorTxId, hash, link } = opts;

	if (link.anchorPaymentTxHash && link.anchorPayStatus === "submitted") {
		return {
			httpStatus: 200,
			body: {
				status: "submitted",
				anchorTxId,
				anchorPaymentTxHash: link.anchorPaymentTxHash,
			},
		};
	}
	if (link.anchorPayStatus === "failed") {
		throw new ApiError(
			409,
			"invalid_state",
			"classic payment to the anchor was rejected on-chain; do not retry",
		);
	}

	const lookup =
		runtime.lookupClassicTxByHash ??
		((h: string) => defaultLookupClassicTxByHash(h));
	const seen = await lookup(hash);

	if (seen.found && seen.successful) {
		await db.claimLink.update({
			where: { paymentId },
			data: {
				anchorPaymentTxHash: hash,
				anchorPayStatus: "submitted",
			},
		});
		return {
			httpStatus: 200,
			body: {
				status: "submitted",
				anchorTxId,
				anchorPaymentTxHash: hash,
			},
		};
	}

	if (seen.found && !seen.successful) {
		await db.claimLink.update({
			where: { paymentId },
			data: { anchorPayStatus: "failed" },
		});
		throw new ApiError(
			409,
			"invalid_state",
			"classic payment to the anchor was rejected on-chain; do not retry",
		);
	}

	// Unresolved (NOT_FOUND / network). Local expiry must not invent a new payment.
	// Proven success above is never blocked by the clock.
	const nowSec = Math.floor(Date.now() / 1000);
	if (link.anchorPayMaxTime !== null && nowSec > link.anchorPayMaxTime) {
		// Still 202 — expiry without Horizon proof forbids resubmit, not a new attempt.
		return {
			httpStatus: 202,
			body: { status: "pending", anchorTxId, pendingTxHash: hash },
		};
	}

	return {
		httpStatus: 202,
		body: { status: "pending", anchorTxId, pendingTxHash: hash },
	};
}

export async function executeAnchorPay(opts: {
	db: Db;
	runtime: ApiRuntime;
	paymentId: string;
	anchorTxId: string;
	classicAddress: string;
	authSecret: string;
	statusView: AnchorWithdrawStatusResult;
	horizon?: ClassicPaymentHorizon;
}): Promise<AnchorPayOutcome> {
	const {
		db,
		runtime,
		paymentId,
		anchorTxId,
		classicAddress,
		authSecret,
		statusView,
		horizon,
	} = opts;

	const link = (await db.claimLink.findUniqueOrThrow({
		where: { paymentId },
	})) as PayLinkRow;

	if (link.anchorPaymentTxHash && link.anchorPayStatus === "submitted") {
		return {
			httpStatus: 200,
			body: {
				status: "submitted",
				anchorTxId,
				anchorPaymentTxHash: link.anchorPaymentTxHash,
			},
		};
	}
	if (link.anchorPayStatus === "failed") {
		throw new ApiError(
			409,
			"invalid_state",
			"classic payment to the anchor was rejected on-chain; do not retry",
		);
	}

	// Any retained hash → public replay = Horizon reconcile only (no resubmit).
	if (link.anchorPayPendingTxHash) {
		return reconcileByRetainedHash({
			db,
			runtime,
			paymentId,
			anchorTxId,
			hash: link.anchorPayPendingTxHash,
			link,
		});
	}

	// New payment only in this SEP-24 state.
	if (statusView.status !== "pending_user_transfer_start") {
		throw new ApiError(
			409,
			"invalid_state",
			`classic payment requires SEP-24 status pending_user_transfer_start (got ${statusView.status})`,
		);
	}

	const reserved = await db.claimLink.updateMany({
		where: {
			paymentId,
			anchorTxId,
			anchorPayStatus: null,
			anchorPayPendingTxHash: null,
		},
		data: { anchorPayStatus: "prepared" },
	});
	if (reserved.count === 0) {
		const again = (await db.claimLink.findUniqueOrThrow({
			where: { paymentId },
		})) as PayLinkRow;
		if (again.anchorPaymentTxHash && again.anchorPayStatus === "submitted") {
			return {
				httpStatus: 200,
				body: {
					status: "submitted",
					anchorTxId,
					anchorPaymentTxHash: again.anchorPaymentTxHash,
				},
			};
		}
		if (again.anchorPayStatus === "failed") {
			throw new ApiError(
				409,
				"invalid_state",
				"classic payment to the anchor was rejected on-chain; do not retry",
			);
		}
		if (again.anchorPayPendingTxHash) {
			return reconcileByRetainedHash({
				db,
				runtime,
				paymentId,
				anchorTxId,
				hash: again.anchorPayPendingTxHash,
				link: again,
			});
		}
		throw new ApiError(
			409,
			"invalid_state",
			"anchor pay already in progress for this claim",
		);
	}

	try {
		const envAsset =
			runtime.anchorAsset ?? loadAnchorEventEnv(process.env).asset;
		const expectation = expectationFromStatus(statusView, envAsset);
		const source = Keypair.fromSecret(authSecret);
		if (source.publicKey() !== classicAddress) {
			throw new ApiError(
				409,
				"invalid_state",
				"custodial auth key does not match vault-release classic address",
			);
		}

		const built: SignedClassicPayment = runtime.buildAnchorClassicPayment
			? await runtime.buildAnchorClassicPayment({
					source,
					expectation,
					networkPassphrase: envAsset.networkPassphrase,
				})
			: await buildAndSignClassicPaymentWithMemo({
					source,
					expectation,
					networkPassphrase: envAsset.networkPassphrase,
					horizon,
					timeoutSeconds: 60,
				});

		const fields = paymentFieldsFromSignedTx(built.signedTx);
		const envelopeXdr = Buffer.from(built.signedTx.toXDR(), "base64");
		const sealed = sealBytes(envelopeXdr, runtime.claimSealKey);

		const persisted = await db.claimLink.updateMany({
			where: {
				paymentId,
				anchorTxId,
				anchorPayStatus: "prepared",
				anchorPayPendingTxHash: null,
			},
			data: {
				anchorPayPendingTxHash: built.txHash,
				anchorPayPendingSealed: sealed.sealed,
				anchorPayPendingSealedNonce: sealed.nonce,
				anchorPayMinTime: built.timeBounds.minTime,
				anchorPayMaxTime: built.timeBounds.maxTime,
				anchorPayStatus: "prepared",
			},
		});
		if (persisted.count === 0) {
			throw new ApiError(
				409,
				"invalid_state",
				"anchor pay reservation lost before persist",
			);
		}

		return await submitAsWinner({
			db,
			runtime,
			paymentId,
			anchorTxId,
			txHash: built.txHash,
			signedTx: built.signedTx,
			destination: fields.destination,
			amount: fields.amount,
			asset: built.asset,
			horizon,
		});
	} catch (e) {
		await db.claimLink
			.updateMany({
				where: {
					paymentId,
					anchorPayStatus: "prepared",
					anchorPayPendingTxHash: null,
				},
				data: { anchorPayStatus: null },
			})
			.catch(() => {});
		mapPayError(e);
	}
}

/** Only the reservation winner calls this — never public replay. */
async function submitAsWinner(opts: {
	db: Db;
	runtime: ApiRuntime;
	paymentId: string;
	anchorTxId: string;
	txHash: string;
	signedTx: Transaction;
	destination: string;
	amount: string;
	asset: { code: string; issuer: string; networkPassphrase: string };
	horizon?: ClassicPaymentHorizon;
}): Promise<AnchorPayOutcome> {
	const { db, runtime, paymentId, anchorTxId, txHash, signedTx, horizon } = opts;

	try {
		const result: ClassicPaymentResult = runtime.submitAnchorClassicPayment
			? await runtime.submitAnchorClassicPayment({
					signedTx,
					expectedTxHash: txHash,
				})
			: await submitSignedClassicPayment({
					signedTx,
					expectedTxHash: txHash,
					destination: opts.destination,
					amount: opts.amount,
					asset: opts.asset,
					horizon,
				});

		await db.claimLink.update({
			where: { paymentId },
			data: {
				anchorPaymentTxHash: result.txHash,
				anchorPayStatus: "submitted",
			},
		});

		return {
			httpStatus: 200,
			body: {
				status: "submitted",
				anchorTxId,
				anchorPaymentTxHash: result.txHash,
			},
		};
	} catch (e) {
		if (isDefinitiveHorizonReject(e)) {
			await db.claimLink.update({
				where: { paymentId },
				data: { anchorPayStatus: "failed" },
			});
			throw new ApiError(
				409,
				"invalid_state",
				"classic payment to the anchor was rejected on-chain; do not retry",
			);
		}
		await db.claimLink.update({
			where: { paymentId },
			data: { anchorPayStatus: "uncertain" },
		});
		return {
			httpStatus: 202,
			body: { status: "pending", anchorTxId, pendingTxHash: txHash },
		};
	}
}

/** Test helper: unseal retained envelope and read payment fields. */
export function decodeRetainedEnvelopeFields(
	runtime: ApiRuntime,
	link: PayLinkRow,
): { destination: string; amount: string; txHash: string } {
	if (
		!link.anchorPayPendingTxHash ||
		!link.anchorPayPendingSealed ||
		!link.anchorPayPendingSealedNonce
	) {
		throw new Error("no retained envelope");
	}
	const networkPassphrase =
		runtime.anchorAsset?.networkPassphrase ??
		loadAnchorEventEnv(process.env).networkPassphrase;
	const xdrBuf = unsealBytes(
		Buffer.from(link.anchorPayPendingSealed),
		Buffer.from(link.anchorPayPendingSealedNonce),
		runtime.claimSealKey,
	);
	const parsed = TransactionBuilder.fromXDR(
		xdrBuf.toString("base64"),
		networkPassphrase,
	) as Transaction;
	const fields = paymentFieldsFromSignedTx(parsed);
	return {
		...fields,
		txHash: link.anchorPayPendingTxHash,
	};
}
