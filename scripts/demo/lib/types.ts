import type {
	EndpointType,
	FeeMode,
	LegKind,
	LegStatus,
	PaymentStatus,
	RecipientKind,
} from "@flexipay/domain"

// Lane-D's internal view of a demo flow. These are semantic shapes: the fields documented in
// ARCHITECTURE §6.4–§6.7, not request or envelope wire shapes. `lib/api.ts` is the only place
// allowed to map them to A0 schemas; nothing here is sent to the API directly.

export interface MoneyView {
	amount: string
	currency: string
}

export interface LegView {
	kind: LegKind
	rail: string
	status: LegStatus
	externalRef?: string
	error?: { code?: string; message?: string }
	simulated?: boolean
}

export interface EventView {
	type: string
	createdAt?: string
	paymentId?: string
	/** Published Event.snapshot; used to attribute a leg.failed event to its attempt. */
	snapshot?: unknown
}

export interface RouteLegView {
	kind: LegKind
	rail?: string
}

export interface PaymentView {
	id: string
	status: PaymentStatus
	legs: LegView[]
	delivery?: string
	externalId?: string
	quoteId?: string
	batchId?: string
	events?: EventView[]
	simulated?: boolean
}

export interface QuoteView {
	id: string
	route: RouteLegView[]
	reasons: string[]
	expectedReceive: MoneyView
	validUntil: string
	simulated: boolean
	/** Echo of the vault mode used to price settle; null when the route has no settle leg. */
	feeMode: FeeMode | null
	fxRate?: string
	fees?: unknown
	alternatives?: unknown[]
}

export interface BatchView {
	id: string
	status: string
	paymentIds: string[]
	totals?: unknown
}

export interface ClaimView {
	status: string
	amount?: MoneyView
	allowedEndpointTypes?: EndpointType[]
	reasons?: string[]
}

export interface RecipientView {
	id: string
	name: string
}

export interface EndpointView {
	id: string
	recipientId: string
	type: EndpointType
}

export interface RecipientInput {
	name: string
	kind: RecipientKind
	country: string
}

export interface EndpointInput {
	recipientId: string
	type: EndpointType
	country: string
	currency: string
	network?: "stellar"
	/** Synthetic details from the fixture; never printed. */
	details: Record<string, string>
	simulated: true
}

export interface DestinationInput {
	type: EndpointType
	country: string
	currency: string
	recipientKind: RecipientKind
}

export interface QuoteInput {
	destination: DestinationInput
	amount: MoneyView
	amountSide: "send" | "receive"
	/** Required by the published schema whenever the chosen route settles; no demo default. */
	feeMode: FeeMode
	policy?: "cheapest"
}

export interface PaymentInput {
	quoteId: string
	recipientId: string
	endpointId?: string
	externalId: string
	delivery: "direct" | "claim_link"
	profile: "small" | "batch" | "invoice" | "tips" | "domestic" | "one_off"
	idempotencyKey?: string
}

export interface BatchRowInput {
	recipientId: string
	endpointId: string
	amount: MoneyView
	externalId: string
	profile: "batch"
}

export interface PaymentHandle {
	payment: PaymentView
	/** Raw claim token, present only for a claim link; never printed or written to evidence. */
	claimToken?: string
}

export interface AcceptInput {
	endpointId?: string
	type: EndpointType
	/** Stellar address for a crypto destination; omitted for mock mode. */
	address?: string
	details?: Record<string, string>
}

/** The operations every DF script needs. Implemented only by `lib/api.ts`. */
export interface DemoApi {
	createRecipient(input: RecipientInput): Promise<RecipientView>
	createEndpoint(input: EndpointInput): Promise<EndpointView>
	quote(input: QuoteInput): Promise<QuoteView>
	createPayment(input: PaymentInput): Promise<PaymentHandle>
	fund(paymentId: string): Promise<PaymentView>
	payment(paymentId: string): Promise<PaymentView>
	events(paymentId: string): Promise<EventView[]>
	createBatch(rows: BatchRowInput[]): Promise<BatchView>
	batch(batchId: string): Promise<BatchView>
	claim(token: string): Promise<ClaimView>
	acceptClaim(token: string, input: AcceptInput): Promise<PaymentView>
	failNext(providerId: string, count: number): Promise<void>
	/** Moves the API clock; ledger time is not affected. */
	advanceTime(seconds: number): Promise<void>
}
