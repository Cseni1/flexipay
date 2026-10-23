import type {
	EndpointType,
	FeeMode,
	LegKind,
	Money,
	ProviderAdapter,
	SettlementAdapter,
} from "@flexipay/domain";

/**
 * Explicit execution plan for CC2 tests / callers that already have priced legs.
 * Not a CC1 Quote substitute in production — amounts and feeMode must be supplied
 * by the caller (CCR-8: feeMode comes from the quote when that path exists).
 */
export interface ExecutionLegPlan {
	kind: LegKind;
	rail: string;
	providerId: string;
	amountIn: Money;
	amountOut: Money;
	simulated: boolean;
}

export interface ExecutionPlan {
	legs: ExecutionLegPlan[];
	/**
	 * Required when any leg is `settle` (CCR-8). Null only when the route has no settle.
	 * Orchestrator never invents a default.
	 */
	feeMode: FeeMode | null;
	/** Vault lock expiry for settle legs. */
	lockExpiresAt: Date;
	/**
	 * Crypto claim-wait route (ARCHITECTURE §7): after lock, settle stays `processing`
	 * until `completeClaimSettle`. Fiat routes with settle complete settle at lock.
	 */
	claimWaitSettle: boolean;
	/** Destination endpoint for payout legs (direct delivery). */
	payoutEndpoint?: {
		endpointId: string;
		type: EndpointType;
		country: string;
		currency: string;
	};
	/** Stellar (or mock) receiving address for claim release. */
	claimDestination?: string;
}

export interface OrchestratorAdapters {
	getProvider: (id: string) => ProviderAdapter | undefined;
	settlement: SettlementAdapter;
	/** Payer address used for vault fund/lock (testnet / mock account id). */
	vaultPayer: string;
	now: () => Date;
}

export interface CreatePaymentInput {
	organizationId: string;
	recipientId: string;
	quoteId: string;
	delivery: "direct" | "claim_link";
	profile: string;
	externalId?: string;
	reference?: string;
	plan: ExecutionPlan;
}
