// Browser-safe claim contract view. Re-export only the merged A0 claim schemas so the claim
// page does not pull the domain root (and its Node config loader) into the web bundle.

export {
	ClaimAcceptRequestSchema,
	ClaimAcceptResponseSchema,
	ClaimViewSchema,
} from "../domain/src/api/claims.ts"

export type {
	ClaimAcceptRequest,
	ClaimAcceptResponse,
	ClaimLinkStatus,
	ClaimView,
} from "../domain/src/api/claims.ts"
