// Browser-safe claim contract view. Re-export only the merged A0 claim schemas so the claim
// page does not pull the domain root (and its Node config loader) into the web bundle.

export {
	ClaimAcceptRequestSchema,
	ClaimAcceptResponseSchema,
	ClaimViewSchema,
	// CCR-20 deploy is mounted on the API; prepare/submit are not, so only the deploy wire
	// schemas are re-exported here. They are the accepted shared schemas, not copies.
	PasskeyDeployRequestSchema,
	PasskeyDeployResponseSchema,
} from "../domain/src/api/claims.ts"

export type {
	ClaimAcceptRequest,
	ClaimAcceptResponse,
	ClaimLinkStatus,
	ClaimView,
	PasskeyDeployRequest,
	PasskeyDeployResponse,
} from "../domain/src/api/claims.ts"
