// Browser-safe view of the merged A0 contract. The domain package root also exports the Node
// config loader, so the web app imports only these API schemas and enum types.

export {
	ClaimAcceptEndpointSchema,
	ClaimAcceptRequestSchema,
	ClaimAcceptResponseSchema,
	ClaimViewSchema,
	CreatePaymentRequestSchema,
	CreateQuoteRequestSchema,
	EventListResponseSchema,
	EventSchema,
	PaymentDetailSchema,
	PaymentListResponseSchema,
	PaymentSchema,
	QuoteSchema,
} from "../domain/src/api/index.ts"

export { FEE_MODES, PAYMENT_STATUSES } from "../domain/src/enums.ts"

export type {
	AlternativeRoute,
	ClaimAcceptRequest,
	ClaimAcceptResponse,
	ClaimLinkHandle,
	ClaimView,
	CreatePaymentRequest,
	CreateQuoteRequest,
	Event,
	EventType,
	FeeBreakdown,
	Leg,
	Payment,
	PaymentDetail,
	PaymentListResponse,
	PlannedLeg,
	Quote,
} from "../domain/src/api/index.ts"

export type {
	Delivery,
	EndpointType,
	FeeMode,
	LegStatus,
	PaymentStatus,
	RecipientKind,
} from "../domain/src/enums.ts"
