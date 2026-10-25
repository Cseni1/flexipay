import type { FlexiPayConfig, ProviderAdapter, SettlementAdapter } from "@flexipay/domain";
import { createSimProviders, type SimProviders } from "@flexipay/adapters-sim";
import type {
	AnchorPaymentExpectation,
	ClassicPaymentResult,
	SignedClassicPayment,
	StellarAssetIdentity,
} from "@flexipay/adapter-stellar";
import type { Keypair, Transaction } from "@stellar/stellar-sdk";
import type { AnchorClaimGateway } from "./anchor/claim-anchor-gateway.ts";
import type { ClassicTxLookupResult } from "./anchor/claim-anchor-pay.ts";
import { createAnchorSettlement } from "./anchor/settlement-from-anchor-env.ts";
import { createSettlement, settlementModeFromEnv } from "./settlement.ts";
import { claimSealKeyFromEnv } from "./orchestrator/claim-seal.ts";

/**
 * The API clock (CCR-6). Moves quote and claim expiry only; it never moves ledger time
 * (CCR-5), so the settlement adapters keep their own clock.
 */
export interface ApiClock {
	now(): Date;
	/** Moves the API clock forward by `seconds`; returns the clock after the advance. */
	advance(seconds: number): Date;
	/** Back to wall-clock time (sandbox reset). */
	reset(): void;
}

export function createApiClock(wall: () => Date = () => new Date()): ApiClock {
	let offsetMs = 0;
	return {
		now: () => new Date(wall().getTime() + offsetMs),
		advance(seconds) {
			offsetMs += seconds * 1000;
			return new Date(wall().getTime() + offsetMs);
		},
		reset() {
			offsetMs = 0;
		},
	};
}

export interface ApiRuntime {
	getProvider: (id: string) => ProviderAdapter | undefined;
	settlement: SettlementAdapter;
	/** CCR-10: true when FP_SETTLEMENT=mock (baseline). False when FP_ANCHOR_MODE=1. */
	settlementSimulated: boolean;
	vaultPayer: string;
	now: () => Date;
	/** Source of `now`; sandbox advance-time and reset act on it (CCR-6). */
	clock: ApiClock;
	claimSealKey: Buffer;
	/** Base for claim URLs, e.g. https://api.example (no trailing slash). */
	apiPublicBase: string;
	sim?: SimProviders;
	/** True when createApiRuntime selected FP_ANCHOR_MODE=1. */
	anchorMode?: boolean;
	/**
	 * CCR-22: injectable reference-anchor gateway (tests). When omitted, routes
	 * build from FP_ANCHOR_* via createEnvAnchorClaimGateway.
	 */
	anchorGateway?: AnchorClaimGateway;
	/** Optional SEP-10 secret resolver for vault-release classic G… (tests). */
	resolveAnchorAuthSecret?: (classicAddress: string) => string | undefined;
	/** Optional anchor asset identity (tests /pay / FP_ANCHOR_MODE). */
	anchorAsset?: StellarAssetIdentity;
	/** Optional build/sign classic payment (tests). */
	buildAnchorClassicPayment?: (opts: {
		source: Keypair;
		expectation: AnchorPaymentExpectation;
		networkPassphrase: string;
	}) => Promise<SignedClassicPayment>;
	/** Optional submit of already-signed classic payment (tests). */
	submitAnchorClassicPayment?: (opts: {
		signedTx: Transaction;
		expectedTxHash: string;
	}) => Promise<ClassicPaymentResult>;
	/** Optional Horizon tx lookup by hash (tests /pay reconcile). */
	lookupClassicTxByHash?: (hash: string) => Promise<ClassicTxLookupResult>;
}

export async function createApiRuntime(
	config: FlexiPayConfig,
	env: Record<string, string | undefined> = process.env,
): Promise<ApiRuntime> {
	const clock = createApiClock();
	const claimSealKey = claimSealKeyFromEnv(env);
	const apiPublicBase = (env.FP_API_URL ?? "").replace(/\/$/, "");
	const sim = createSimProviders(config);
	const vaultPayer =
		env.FP_PAYER_DEMO_ADDRESS?.trim() ||
		"GDEMOPAYER000000000000000000000000000000000000000000";

	const anchorMode = env.FP_ANCHOR_MODE?.trim() === "1";
	if (anchorMode) {
		// Anchor mode releases real testnet funds to the recipient's classic account. On the
		// in-memory mock nothing would reach the chain, so refuse rather than mislabel it.
		if (settlementModeFromEnv(env) !== "stellar") {
			throw new Error(
				"FP_ANCHOR_MODE=1 requires FP_SETTLEMENT=stellar (the reference-anchor route needs a real vault release; the mock cannot provide one)",
			);
		}
		const { adapter, mapping } = await createAnchorSettlement({ env });
		return {
			getProvider: (id) => sim.providers.get(id),
			settlement: adapter,
			settlementSimulated: adapter.network === "mock",
			vaultPayer,
			now: () => clock.now(),
			clock,
			claimSealKey,
			apiPublicBase,
			sim,
			anchorMode: true,
			anchorAsset: mapping.anchor.asset,
		};
	}

	const mode = settlementModeFromEnv(env);
	const { adapter } = await createSettlement({ env });
	return {
		getProvider: (id) => sim.providers.get(id),
		settlement: adapter,
		settlementSimulated: mode === "mock",
		vaultPayer,
		now: () => clock.now(),
		clock,
		claimSealKey,
		apiPublicBase,
		sim,
		anchorMode: false,
	};
}
