// Browser-safe claim contract view. Re-export only the shared claim schemas so the claim page
// does not pull the domain root (and its Node config loader) into the web bundle. These are the
// accepted shared schemas (CCR-21, CCR-22), not copies.

export {
	AnchorIndicativePriceRequestSchema,
	AnchorIndicativePriceResponseSchema,
	AnchorPayPendingResponseSchema,
	AnchorPayRequestSchema,
	AnchorPayResponseSchema,
	AnchorUsdcMajorAmountSchema,
	AnchorWithdrawRequestSchema,
	AnchorWithdrawResponseSchema,
	AnchorWithdrawStatusResponseSchema,
	ClaimAcceptRequestSchema,
	ClaimAcceptResponseSchema,
	ClaimViewSchema,
	PasskeyDeployRequestSchema,
	PasskeyDeployResponseSchema,
	PasskeyPrepareRequestSchema,
	PasskeyPrepareResponseSchema,
	PasskeySubmitPendingResponseSchema,
	PasskeySubmitRequestSchema,
	PasskeySubmitResponseSchema,
} from "../domain/src/api/claims.ts"

export type {
	AnchorIndicativePriceRequest,
	AnchorIndicativePriceResponse,
	AnchorPayPendingResponse,
	AnchorPayRequest,
	AnchorPayResponse,
	AnchorWithdrawRequest,
	AnchorWithdrawResponse,
	AnchorWithdrawStatusResponse,
	ClaimAcceptRequest,
	ClaimAcceptResponse,
	ClaimLinkStatus,
	ClaimView,
	PasskeyDeployRequest,
	PasskeyDeployResponse,
	PasskeyPrepareRequest,
	PasskeyPrepareResponse,
	PasskeySubmitPendingResponse,
	PasskeySubmitRequest,
	PasskeySubmitResponse,
} from "../domain/src/api/claims.ts"
