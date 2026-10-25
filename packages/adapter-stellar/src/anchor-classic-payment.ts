import {
	Asset,
	Horizon,
	Keypair,
	Memo,
	Operation,
	Transaction,
	TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { StellarAssetIdentity } from "./anchor-asset.ts";
import { assertAssetIdentity } from "./anchor-asset.ts";
import type { AnchorPaymentExpectation } from "./anchor-client.ts";
import { AnchorClientError } from "./anchor-client.ts";

/**
 * Classic-account payment to the reference anchor with the required memo.
 * Used after SEP-24 withdraw reaches `pending_user_transfer_start` (customer pays).
 * Also usable when a SEP-24 deposit instructs an off-chain/on-chain step that
 * resolves to a Stellar payment (rare for deposit; deposit usually uses interactive
 * bank→anchor, then credit). For M1 withdraw, this is the customer→anchor leg.
 *
 * Prefer {@link buildAndSignClassicPaymentWithMemo} then {@link submitSignedClassicPayment}
 * when DF7 must record the hash before Horizon accepts the tx. Never log signed
 * envelopes, XDR, or secrets.
 */

export interface ClassicPaymentResult {
	/** Horizon transaction hash (on-chain payment to the anchor). */
	txHash: string;
	destination: string;
	amount: string;
	memoPresent: true;
	asset: { code: string; issuer: string; networkPassphrase: string };
}

/** Unix-second time bounds on the signed payment (both finite). */
export interface ClassicPaymentTimeBounds {
	minTime: number;
	maxTime: number;
}

export interface SignedClassicPayment {
	/** Network tx hash of the signed envelope (available before submit). */
	txHash: string;
	/** Signed Transaction — pass to {@link submitSignedClassicPayment}; never log. */
	signedTx: Transaction;
	timeBounds: ClassicPaymentTimeBounds;
	destination: string;
	amount: string;
	memoPresent: true;
	asset: { code: string; issuer: string; networkPassphrase: string };
}

/** Horizon surface used by classic payment (injectable for unit tests). */
export interface ClassicPaymentHorizon {
	loadAccount(address: string): Promise<AccountLike>;
	fetchBaseFee(): Promise<number>;
	submitTransaction(
		tx: Transaction,
	): Promise<{ hash?: string; id?: string }>;
}

/** Minimal account shape accepted by TransactionBuilder. */
export type AccountLike = ConstructorParameters<typeof TransactionBuilder>[0];

export interface BuildClassicPaymentOptions {
	horizonUrl?: string;
	/** Override Horizon client (tests); default `new Horizon.Server(horizonUrl)`. */
	horizon?: ClassicPaymentHorizon;
	networkPassphrase: string;
	source: Keypair;
	expectation: AnchorPaymentExpectation;
	/** Defaults to 30. Sets a finite maxTime = now + timeoutSeconds. */
	timeoutSeconds?: number;
}

export type SubmitClassicPaymentOptions = BuildClassicPaymentOptions;

export interface SubmitSignedClassicPaymentOptions {
	horizonUrl?: string;
	/** Override Horizon client (tests). */
	horizon?: ClassicPaymentHorizon;
	/** Already-signed payment from {@link buildAndSignClassicPaymentWithMemo}. */
	signedTx: Transaction;
	/**
	 * When set, must equal `signedTx.hash()` hex. Use the pre-submit hash from
	 * build so callers can prove the submitted bytes are unchanged.
	 */
	expectedTxHash?: string;
	/** Echo fields for the result (same as build). */
	destination: string;
	amount: string;
	asset: { code: string; issuer: string; networkPassphrase: string };
}

const DEFAULT_HORIZON = "https://horizon-testnet.stellar.org";

function resolveHorizon(
	horizonUrl: string | undefined,
	horizon: ClassicPaymentHorizon | undefined,
): ClassicPaymentHorizon {
	return horizon ?? new Horizon.Server(horizonUrl ?? DEFAULT_HORIZON);
}
function assertPaymentExpectation(
	expectation: AnchorPaymentExpectation,
	networkPassphrase: string,
): void {
	assertAssetIdentity(expectation.asset);
	if (expectation.asset.networkPassphrase !== networkPassphrase) {
		throw new AnchorClientError(
			"network_mismatch",
			"payment asset networkPassphrase does not match submit options",
		);
	}
	if (!expectation.destination || !expectation.memo || !expectation.amount) {
		throw new AnchorClientError(
			"sep24_missing_payment_fields",
			"classic payment requires destination, memo and amount",
		);
	}
}

function finiteTimeBounds(tx: Transaction): ClassicPaymentTimeBounds {
	const raw = tx.timeBounds;
	if (!raw) {
		throw new AnchorClientError(
			"classic_payment_failed",
			"signed payment missing time bounds",
		);
	}
	const minTime = Number(raw.minTime);
	const maxTime = Number(raw.maxTime);
	if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) {
		throw new AnchorClientError(
			"classic_payment_failed",
			"signed payment time bounds are not finite",
		);
	}
	if (!(maxTime > minTime)) {
		throw new AnchorClientError(
			"classic_payment_failed",
			"signed payment time bounds are empty or inverted",
		);
	}
	return { minTime, maxTime };
}

function txHashHex(tx: Transaction): string {
	return Buffer.from(tx.hash()).toString("hex");
}

/**
 * Build and sign the classic memo payment. Returns the hash and signed
 * transaction **before** any Horizon submit. Does not log the envelope.
 */
export async function buildAndSignClassicPaymentWithMemo(
	opts: BuildClassicPaymentOptions,
): Promise<SignedClassicPayment> {
	const { expectation, source, networkPassphrase } = opts;
	assertPaymentExpectation(expectation, networkPassphrase);

	const destination = expectation.destination;
	const memoText = expectation.memo;
	const amount = expectation.amount;
	// assertPaymentExpectation guarantees these; narrow for the builder.
	if (!destination || !memoText || !amount) {
		throw new AnchorClientError(
			"sep24_missing_payment_fields",
			"classic payment requires destination, memo and amount",
		);
	}

	const server = resolveHorizon(opts.horizonUrl, opts.horizon);
	const account = await server.loadAccount(source.publicKey());
	const fee = await server.fetchBaseFee();
	const asset = toSdkAsset(expectation.asset);
	const memo = toMemo(memoText, expectation.memoType);

	const timeoutSeconds = opts.timeoutSeconds ?? 30;
	const nowSec = Math.floor(Date.now() / 1000);
	const minTime = nowSec;
	const maxTime = nowSec + timeoutSeconds;

	const tx = new TransactionBuilder(account, {
		fee: fee.toString(),
		networkPassphrase,
	})
		.addOperation(
			Operation.payment({
				destination,
				asset,
				amount,
			}),
		)
		.addMemo(memo)
		.setTimebounds(minTime, maxTime)
		.build();
	tx.sign(source);

	const timeBounds = finiteTimeBounds(tx);
	const txHash = txHashHex(tx);

	return {
		txHash,
		signedTx: tx,
		timeBounds,
		destination,
		amount,
		memoPresent: true,
		asset: {
			code: expectation.asset.code,
			issuer: expectation.asset.issuer,
			networkPassphrase,
		},
	};
}

/**
 * Submit an already-signed classic payment. Does not re-sign or rebuild.
 * Never logs the signed envelope.
 */
export async function submitSignedClassicPayment(
	opts: SubmitSignedClassicPaymentOptions,
): Promise<ClassicPaymentResult> {
	const submittedHash = txHashHex(opts.signedTx);
	if (opts.expectedTxHash && opts.expectedTxHash !== submittedHash) {
		throw new AnchorClientError(
			"classic_payment_failed",
			"signed payment hash does not match expectedTxHash (transaction mutated before submit)",
		);
	}

	const server = resolveHorizon(opts.horizonUrl, opts.horizon);
	const submitted = await server.submitTransaction(opts.signedTx);
	const txHash =
		typeof submitted.hash === "string"
			? submitted.hash
			: String((submitted as { id?: string }).id ?? "");
	if (!txHash) {
		throw new AnchorClientError(
			"classic_payment_failed",
			"Horizon submit returned no transaction hash",
		);
	}
	if (txHash !== submittedHash) {
		throw new AnchorClientError(
			"classic_payment_failed",
			"Horizon hash does not match signed payment hash",
		);
	}
	return {
		txHash,
		destination: opts.destination,
		amount: opts.amount,
		memoPresent: true,
		asset: opts.asset,
	};
}

/**
 * Compatible one-shot helper: build/sign then submit.
 * DF7 that needs the pre-submit hash should call the split helpers instead.
 */
export async function submitClassicPaymentWithMemo(
	opts: SubmitClassicPaymentOptions,
): Promise<ClassicPaymentResult> {
	const built = await buildAndSignClassicPaymentWithMemo(opts);
	return submitSignedClassicPayment({
		horizonUrl: opts.horizonUrl,
		horizon: opts.horizon,
		signedTx: built.signedTx,
		expectedTxHash: built.txHash,
		destination: built.destination,
		amount: built.amount,
		asset: built.asset,
	});
}

function toSdkAsset(asset: StellarAssetIdentity): Asset {
	if (asset.code === "native" || asset.issuer === "") return Asset.native();
	return new Asset(asset.code, asset.issuer);
}

function toMemo(memo: string, memoType?: string): Memo {
	const kind = (memoType ?? "text").toLowerCase();
	switch (kind) {
		case "id":
			return Memo.id(memo);
		case "hash":
			return Memo.hash(memo);
		case "return":
			return Memo.return(memo);
		case "text":
		default:
			return Memo.text(memo);
	}
}
