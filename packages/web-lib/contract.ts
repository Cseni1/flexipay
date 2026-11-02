// Browser-safe view of the merged A0 contract. Import specific modules (never the domain
// api barrel) so CCR-21/CCR-22 claim schemas stay out of the web bundle.

export {
	ClaimAcceptEndpointSchema,
	ClaimAcceptRequestSchema,
	ClaimAcceptResponseSchema,
	ClaimViewSchema,
} from "../domain/src/api/claims-public.ts"
export {
	CreatePaymentRequestSchema,
	PaymentDetailSchema,
	PaymentListResponseSchema,
	PaymentSchema,
} from "../domain/src/api/payments.ts"
export {
	CreateQuoteRequestSchema,
	QuoteSchema,
} from "../domain/src/api/quotes.ts"
export {
	EventListResponseSchema,
	EventSchema,
} from "../domain/src/api/events.ts"

export { FEE_MODES, PAYMENT_STATUSES } from "../domain/src/enums.ts"

export type {
	ClaimAcceptRequest,
	ClaimAcceptResponse,
	ClaimView,
} from "../domain/src/api/claims-public.ts"
export type {
	ClaimLinkHandle,
	CreatePaymentRequest,
	Payment,
	PaymentDetail,
	PaymentListResponse,
} from "../domain/src/api/payments.ts"
export type {
	CreateQuoteRequest,
	Quote,
} from "../domain/src/api/quotes.ts"
export type {
	Event,
	EventType,
} from "../domain/src/api/events.ts"
export type {
	AlternativeRoute,
	FeeBreakdown,
	Leg,
	PlannedLeg,
} from "../domain/src/api/common.ts"

export type {
	Delivery,
	EndpointType,
	FeeMode,
	LegStatus,
	PaymentStatus,
	RecipientKind,
} from "../domain/src/enums.ts"
