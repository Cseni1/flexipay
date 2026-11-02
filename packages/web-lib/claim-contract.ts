// Browser-safe claim contract view. Import only the public claim schemas so the claim page
// does not pull CCR-21/CCR-22 passkey or cash-out schemas into the web bundle.

export {
	ClaimAcceptRequestSchema,
	ClaimAcceptResponseSchema,
	ClaimViewSchema,
} from "../domain/src/api/claims-public.ts"

export type {
	ClaimAcceptRequest,
	ClaimAcceptResponse,
	ClaimLinkStatus,
	ClaimView,
} from "../domain/src/api/claims-public.ts"
