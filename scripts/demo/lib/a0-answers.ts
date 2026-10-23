/**
 * D1 contract questions closed against A0 (`packages/domain/src/api`) + Architecture v5.
 * No new API fields were invented; demos use quotes, legs, events and settle.externalRef.
 *
 * 1. Batch route/reasons — A0 has no batches schema. Reasons live on `QuoteSchema.reasons`.
 *    Payment carries `quoteId` but PaymentDetail does not embed the quote. DF1 proves the
 *    domestic rail from payment legs and captures reasons via a parallel US quote.
 *
 * 2. Payout attempts / leg.failed — `LegSchema` has no `attempt`. Retry proof is
 *    `leg.failed` events (and/or multiple failed payout legs) plus terminal `payment.refunded`.
 *    Cardinality is not fixed in A0; DF4 requires two failure signals for "exactly one retry".
 *
 * 3. Vault refund / settle status — Identify refund by `PaymentStatus=refunded` and
 *    `payment.refunded`. Collect/convert must be `reversed` (§7 / SCENARIOS). Settle status
 *    after SettlementAdapter.refund is not a separate A0 field; do not require settle.reversed.
 *
 * 4. Lock vs release refs — One `Leg.externalRef` on settle. Capture before accept (lock) and
 *    after (release). Release is verified on Stellar RPC; if refs coincide, release RPC proof
 *    still stands (ARCHITECTURE: release is the visible tx).
 *
 * 5. DF5 recipient-kind exclusion — No refusal-code enum in A0. Use non-empty `reasons[]` on
 *    the eligible quote and on a 422 refusal body. Exact prose is not asserted.
 */

export const A0_CONTRACT_ANSWERS = {
	batchReasons:
		"Quote.reasons only; no batch-row reasons in A0. DF1 uses a parallel US quote for explanation.",
	payoutAttempts:
		"No Leg.attempt; prove retry with two leg.failed events and/or two failed payout legs, then payment.refunded.",
	vaultRefund:
		"payment.refunded + status refunded; collect/convert reversed; settle status not asserted.",
	lockRelease:
		"Single settle.externalRef; compare pre/post accept; Stellar release proven via RPC getTransaction.",
	df5Refusal:
		"No stable reason code; non-empty reasons[] on quote and 422 refusal.",
} as const
