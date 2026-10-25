import {
	Asset,
	Horizon,
	Keypair,
	Memo,
	Operation,
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
 */

export interface ClassicPaymentResult {
	/** Horizon transaction hash (on-chain payment to the anchor). */
	txHash: string;
	destination: string;
	amount: string;
	memoPresent: true;
	asset: { code: string; issuer: string; networkPassphrase: string };
}

export interface SubmitClassicPaymentOptions {
	horizonUrl?: string;
	networkPassphrase: string;
	source: Keypair;
	expectation: AnchorPaymentExpectation;
	/** Defaults to 30. */
	timeoutSeconds?: number;
}

const DEFAULT_HORIZON = "https://horizon-testnet.stellar.org";

export async function submitClassicPaymentWithMemo(
	opts: SubmitClassicPaymentOptions,
): Promise<ClassicPaymentResult> {
	const { expectation, source, networkPassphrase } = opts;
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

	const server = new Horizon.Server(opts.horizonUrl ?? DEFAULT_HORIZON);
	const account = await server.loadAccount(source.publicKey());
	const fee = await server.fetchBaseFee();
	const asset = toSdkAsset(expectation.asset);
	const memo = toMemo(expectation.memo, expectation.memoType);

	const tx = new TransactionBuilder(account, {
		fee: fee.toString(),
		networkPassphrase,
	})
		.addOperation(
			Operation.payment({
				destination: expectation.destination,
				asset,
				amount: expectation.amount,
			}),
		)
		.addMemo(memo)
		.setTimeout(opts.timeoutSeconds ?? 30)
		.build();
	tx.sign(source);

	const submitted = await server.submitTransaction(tx);
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
	return {
		txHash,
		destination: expectation.destination,
		amount: expectation.amount,
		memoPresent: true,
		asset: {
			code: expectation.asset.code,
			issuer: expectation.asset.issuer,
			networkPassphrase,
		},
	};
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
