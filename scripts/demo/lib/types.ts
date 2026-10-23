import type {
	EndpointType,
	LegKind,
	LegStatus,
	PaymentStatus,
	RecipientKind,
	SettlementNetwork,
} from "@flexipay/domain"

// Lane-D's internal view of a demo flow. These are semantic shapes: the fields documented in
// ARCHITECTURE §6.4–§6.7, not request or envelope wire shapes. `lib/a0.ts` is the only place
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
	attempt?: number
	simulated?: boolean
}

export interface EventView {
	type: string
	createdAt?: string
	paymentId?: string
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
	/** Settlement network reported for this payment's settle leg, when the API exposes it. */
	network?: SettlementNetwork
	simulated?: boolean
}

export interface QuoteView {
	id: string
	route: RouteLegView[]
	reasons: string[]
	expectedReceive: MoneyView
	validUntil: string
	simulated: boolean
	fxRate?: string
	fees?: unknown
	alternatives?: unknown[]
}

export interface BatchRowView {
	paymentId: string
	status: PaymentStatus
	route?: RouteLegView[]
	reasons?: string[]
}

export interface BatchView {
	id: string
	status: string
	paymentIds: string[]
	rows?: BatchRowView[]
	totals?: unknown
}

export interface ClaimView {
	status: string
	amount?: MoneyView
	allowedEndpointTypes?: EndpointType[]
	reasons?: string[]
}

export interface AcceptanceView {
	payment: PaymentView
	/** The release reference reported by the claim, when the API returns one. */
	release?: { network: SettlementNetwork; txRef: string }
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

/** The operations every DF script needs. Implemented only by `lib/a0.ts`. */
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
	acceptClaim(token: string, input: AcceptInput): Promise<AcceptanceView>
	failNext(providerId: string, count: number): Promise<void>
	/** Moves the API clock; ledger time is not affected. */
	advanceTime(seconds: number): Promise<void>
}
