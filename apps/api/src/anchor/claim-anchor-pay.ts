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
import type { Db } from "../db.ts";
import { ApiError } from "../errors.ts";
import { sealBytes, unsealBytes } from "../orchestrator/claim-seal.ts";
import type { ApiRuntime } from "../runtime.ts";
import type { AnchorWithdrawStatusResult } from "./claim-anchor-gateway.ts";

/**
 * CCR-22 /pay: persist sealed signed envelope + hash + time bounds BEFORE Horizon submit.
 * NOT_FOUND/timeout never starts a new payment — same envelope only.
 */

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

	if (link.anchorPayPendingTxHash && link.anchorPayPendingSealed) {
		return resumePendingPay({
			db,
			runtime,
			paymentId,
			anchorTxId,
			link,
			horizon,
		});
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
		if (again.anchorPayPendingTxHash) {
			return resumePendingPay({
				db,
				runtime,
				paymentId,
				anchorTxId,
				link: again,
				horizon,
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

		return await submitPersistedEnvelope({
			db,
			runtime,
			paymentId,
			anchorTxId,
			txHash: built.txHash,
			signedTx: built.signedTx,
			destination: built.destination,
			amount: built.amount,
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

async function resumePendingPay(opts: {
	db: Db;
	runtime: ApiRuntime;
	paymentId: string;
	anchorTxId: string;
	link: PayLinkRow;
	horizon?: ClassicPaymentHorizon;
}): Promise<AnchorPayOutcome> {
	const { db, runtime, paymentId, anchorTxId, link, horizon } = opts;
	const hash = link.anchorPayPendingTxHash;
	if (!hash || !link.anchorPayPendingSealed || !link.anchorPayPendingSealedNonce) {
		throw new ApiError(
			409,
			"invalid_state",
			"anchor pay pending state is incomplete; do not start a new payment",
		);
	}

	const nowSec = Math.floor(Date.now() / 1000);
	if (link.anchorPayMaxTime !== null && nowSec > link.anchorPayMaxTime) {
		throw new ApiError(
			409,
			"invalid_state",
			"retained classic payment envelope is outside time bounds; NOT_FOUND/timeout does not authorise a new payment",
		);
	}

	if (link.anchorPayStatus === "uncertain") {
		return {
			httpStatus: 202,
			body: { status: "pending", anchorTxId, pendingTxHash: hash },
		};
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
	);
	if (!("hash" in parsed) || typeof (parsed as { hash: () => Buffer }).hash !== "function") {
		throw new ApiError(
			502,
			"classic_payment_failed",
			"retained envelope is not a Transaction",
		);
	}
	const signedTx = parsed as import("@stellar/stellar-sdk").Transaction;
	const restoredHash = Buffer.from(signedTx.hash()).toString("hex");
	if (restoredHash !== hash) {
		throw new ApiError(
			502,
			"classic_payment_failed",
			"restored envelope hash does not match retained pendingTxHash",
		);
	}

	const asset =
		runtime.anchorAsset ?? loadAnchorEventEnv(process.env).asset;
	return submitPersistedEnvelope({
		db,
		runtime,
		paymentId,
		anchorTxId,
		txHash: hash,
		signedTx,
		destination: "GRESUME00000000000000000000000000000000000000000000000",
		amount: "0",
		asset: {
			code: asset.code,
			issuer: asset.issuer,
			networkPassphrase: asset.networkPassphrase,
		},
		horizon,
	});
}

async function submitPersistedEnvelope(opts: {
	db: Db;
	runtime: ApiRuntime;
	paymentId: string;
	anchorTxId: string;
	txHash: string;
	signedTx: import("@stellar/stellar-sdk").Transaction;
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
	} catch {
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
