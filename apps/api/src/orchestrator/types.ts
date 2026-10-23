import type {
	EndpointType,
	FeeMode,
	ProviderAdapter,
	SettlementAdapter,
} from "@flexipay/domain";

export interface OrchestratorAdapters {
	getProvider: (id: string) => ProviderAdapter | undefined;
	settlement: SettlementAdapter;
	/** Payer address used for vault fund/lock (testnet / mock account id). */
	vaultPayer: string;
	now: () => Date;
	/**
	 * Default Stellar (or mock) receiving address for direct-delivery release.
	 * Claim-link accept supplies the recipient destination instead.
	 */
	defaultClaimDestination?: string;
	/** CCR-11 seal key; defaults to `claimSealKeyFromEnv()`. */
	claimSealKey?: Buffer;
}

export interface CreatePaymentFromQuoteInput {
	organizationId: string;
	recipientId: string;
	quoteId: string;
	delivery: "direct" | "claim_link";
	profile: string;
	externalId?: string;
	reference?: string;
}

export type { FeeMode, EndpointType };
