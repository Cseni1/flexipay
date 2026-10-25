import { Keypair } from "@stellar/stellar-sdk";
import {
	AnchorClientError,
	ReferenceAnchorClient,
	isSep24Failure,
	isSep24Success,
	isSep24Terminal,
	loadAnchorEventEnv,
	sep38AssetString,
	type IndicativePrice,
	type Sep24TransactionView,
} from "@flexipay/adapter-stellar";
import { ApiError } from "../errors.ts";

/**
 * Narrow gateway over ReferenceAnchorClient for CCR-22 claim routes.
 * Tests inject a fake; production builds from FP_ANCHOR_* (never baseline FP_USDC_*).
 */

export interface AnchorIndicativeResult {
	indicative: true;
	context: "sep6";
	sellAmount: string;
	buyAmount: string;
	buyAsset: string;
	sellAsset: string;
	price: string;
}

export interface AnchorWithdrawStartResult {
	anchorTxId: string;
	urlSanitised: string;
	/** Raw hosted URL — return once on first HTTP success; never persist/log/cache. */
	interactiveUrl: string;
	kind: "withdrawal";
}

export interface AnchorWithdrawStatusResult {
	anchorTxId: string;
	status: string;
	amountIn?: string;
	withdrawAnchorAccount?: string;
	withdrawMemoPresent: boolean;
	/** SEP-24 stellar_transaction_id — not our classic payment hash. */
	anchorStellarTransactionId?: string;
	/** Derived helpers — used by recovery guards / status.terminal. */
	terminal: boolean;
	success: boolean;
	failure: boolean;
	/** Memo value for /pay only — never HTTP-returned. */
	withdrawMemo?: string;
	withdrawMemoType?: string;
}

export interface AnchorClaimGateway {
	indicativePrice(sellAmount: string): Promise<AnchorIndicativeResult>;
	startWithdraw(opts: {
		amount: string;
		type?: string;
		classicAccount: string;
		authSecret: string;
	}): Promise<AnchorWithdrawStartResult>;
	getWithdrawStatus(opts: {
		anchorTxId: string;
		classicAccount: string;
		authSecret: string;
	}): Promise<AnchorWithdrawStatusResult>;
	/** Public sell asset string (SEP-38) for mismatch checks / handoff. */
	sellAsset(): string;
	/** Home domain label (testnet reference anchor). */
	homeDomain(): string;
}

const DEMO_SECRET_PAIRS: ReadonlyArray<{
	addressEnv: string;
	secretEnv: string;
}> = [
	{ addressEnv: "FP_RECIPIENT_A_ADDRESS", secretEnv: "FP_RECIPIENT_A_SECRET" },
	{ addressEnv: "FP_RECIPIENT_B_ADDRESS", secretEnv: "FP_RECIPIENT_B_SECRET" },
	{ addressEnv: "FP_PAYER_DEMO_ADDRESS", secretEnv: "FP_PAYER_DEMO_SECRET" },
];

/** Resolve custodial classic secret for SEP-10. Never logs the secret. */
export function resolveClassicAuthSecret(
	classicAddress: string,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	const want = classicAddress.trim();
	for (const pair of DEMO_SECRET_PAIRS) {
		const addr = env[pair.addressEnv]?.trim();
		const secret = env[pair.secretEnv]?.trim();
		if (addr && secret && addr === want) return secret;
	}
	return undefined;
}

function mapAnchorError(e: unknown): never {
	if (e instanceof ApiError) throw e;
	if (e instanceof AnchorClientError) {
		if (
			e.code === "sep38_price_failed" ||
			e.code === "not_connected" ||
			e.code === "network_mismatch" ||
			e.code === "asset_not_listed"
		) {
			throw new ApiError(502, "anchor_unavailable", e.message);
		}
		if (
			e.code === "sep24_interactive_failed" ||
			e.code === "sep24_tx_failed" ||
			e.code === "sep10_challenge_failed" ||
			e.code === "sep10_token_failed" ||
			e.code === "sep24_timeout"
		) {
			throw new ApiError(502, "sep24_failed", e.message);
		}
		throw new ApiError(502, "anchor_unavailable", e.message);
	}
	const msg = e instanceof Error ? e.message : "anchor error";
	throw new ApiError(502, "anchor_unavailable", msg);
}

function toStatusView(tx: Sep24TransactionView): AnchorWithdrawStatusResult {
	return {
		anchorTxId: tx.id,
		status: tx.status,
		amountIn: tx.amountIn,
		withdrawAnchorAccount: tx.withdrawAnchorAccount,
		withdrawMemoPresent: Boolean(tx.withdrawMemo),
		anchorStellarTransactionId: tx.stellarTransactionId,
		terminal: isSep24Terminal(tx.status),
		success: isSep24Success(tx.status),
		failure: isSep24Failure(tx.status),
		withdrawMemo: tx.withdrawMemo,
		withdrawMemoType: tx.withdrawMemoType,
	};
}

/**
 * Production gateway: ReferenceAnchorClient + FP_ANCHOR_* overlay.
 * Does not read baseline FP_PAYOUT_VAULT_ID / FP_USDC_*.
 */
export function createEnvAnchorClaimGateway(
	env: Record<string, string | undefined> = process.env,
): AnchorClaimGateway {
	let clientPromise: Promise<ReferenceAnchorClient> | null = null;
	let sellAssetCached: string | null = null;
	let homeDomainCached: string | null = null;

	async function client(): Promise<ReferenceAnchorClient> {
		if (!clientPromise) {
			clientPromise = (async () => {
				try {
					const cfg = loadAnchorEventEnv(env);
					homeDomainCached = cfg.homeDomain;
					sellAssetCached = sep38AssetString(cfg.asset);
					const c = new ReferenceAnchorClient({
						homeDomain: cfg.homeDomain,
						networkPassphrase: cfg.networkPassphrase,
						asset: cfg.asset,
					});
					await c.connect();
					return c;
				} catch (e) {
					clientPromise = null;
					mapAnchorError(e);
				}
			})();
		}
		return clientPromise;
	}

	async function withAuth(
		classicAccount: string,
		authSecret: string,
		run: (c: ReferenceAnchorClient) => Promise<unknown>,
	): Promise<unknown> {
		const c = await client();
		try {
			const kp = Keypair.fromSecret(authSecret);
			if (kp.publicKey() !== classicAccount) {
				throw new ApiError(
					409,
					"invalid_state",
					"custodial auth key does not match vault-release classic address",
				);
			}
			if (!c.hasSession(classicAccount)) {
				await c.authenticate(kp);
			}
			return await run(c);
		} catch (e) {
			mapAnchorError(e);
		}
	}

	return {
		sellAsset() {
			if (!sellAssetCached) {
				const cfg = loadAnchorEventEnv(env);
				sellAssetCached = sep38AssetString(cfg.asset);
				homeDomainCached = cfg.homeDomain;
			}
			return sellAssetCached;
		},
		homeDomain() {
			if (!homeDomainCached) {
				homeDomainCached = loadAnchorEventEnv(env).homeDomain;
			}
			return homeDomainCached;
		},
		async indicativePrice(sellAmount: string): Promise<AnchorIndicativeResult> {
			try {
				const c = await client();
				const price: IndicativePrice = await c.indicativeWithdrawPrice({
					sellAmount,
					buyFiat: "USD",
				});
				return {
					indicative: true,
					context: "sep6",
					sellAmount: price.sellAmount,
					buyAmount: price.buyAmount,
					buyAsset: "iso4217:USD",
					sellAsset: sep38AssetString(c.asset),
					price: price.price,
				};
			} catch (e) {
				mapAnchorError(e);
			}
		},
		async startWithdraw(opts): Promise<AnchorWithdrawStartResult> {
			const session = await withAuth(
				opts.classicAccount,
				opts.authSecret,
				async (c) => {
					const started = await c.startWithdrawInteractive({
						amount: opts.amount,
						type: opts.type,
					});
					return {
						anchorTxId: started.id,
						urlSanitised: started.urlSanitised,
						interactiveUrl: started.url,
						kind: "withdrawal" as const,
					};
				},
			);
			return session as AnchorWithdrawStartResult;
		},
		async getWithdrawStatus(opts): Promise<AnchorWithdrawStatusResult> {
			const view = await withAuth(
				opts.classicAccount,
				opts.authSecret,
				async (c) => toStatusView(await c.getTransaction(opts.anchorTxId)),
			);
			return view as AnchorWithdrawStatusResult;
		},
	};
}
